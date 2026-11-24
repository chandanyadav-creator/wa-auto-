
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const MSG91_AUTHKEY = process.env.MSG91_AUTHKEY;

const TARGET_NUMBER = "917088000907";

const HUBSPOT_BASE_URL = "https://api.hubapi.com";
const MSG91_TEMPLATE_URL =
  "https://control.msg91.com/api/v5/whatsapp/get-template-plugins/?plugin=clevertap&number=" +
  TARGET_NUMBER;

const PROCESSED_FILE = path.join(
  __dirname,
  "processed_button_events.json"
);

const DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

const processingEvents = new Set();

const hubspot = axios.create({
  baseURL: HUBSPOT_BASE_URL,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// --------------------------------------------------
// DEBUG LOGGING
// --------------------------------------------------

function logInfo(message, data = {}) {
  console.log(
    `[INFO ${new Date().toISOString()}] ${message}`,
    data
  );
}

function logError(message, error) {
  console.error(`[ERROR ${new Date().toISOString()}] ${message}`);

  if (error?.response) {
    console.error("HTTP STATUS:", error.response.status);
    console.error(
      "API RESPONSE:",
      JSON.stringify(error.response.data, null, 2)
    );
  } else {
    console.error("ERROR MESSAGE:", error?.message || error);
  }
}

function maskPhone(phone) {
  const number = normalizePhone(phone);

  if (!number) return "N/A";

  return number.length > 4
    ? number.slice(0, 2) + "******" + number.slice(-4)
    : "******";
}

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function normalizePhone(phone) {
  if (!phone) return "";

  let number = String(phone).replace(/\D/g, "");

  if (number.startsWith("00")) {
    number = number.substring(2);
  }

  return number;
}

function formatHubSpotPhone(phone) {
  const number = normalizePhone(phone);
  return number ? "+" + number : "";
}

function cleanCustomerName(name) {
  if (name === undefined || name === null) return "";

  const value = String(name).trim();

  if (
    !value ||
    value.toLowerCase() === "null" ||
    value.toLowerCase() === "undefined" ||
    value.includes("{{")
  ) {
    return "";
  }

  return value;
}

function getCustomerName(data, messages) {
  // MSG91 top-level customerName is the primary source.
  let name = cleanCustomerName(data.customerName);

  // Fallbacks in case a future MSG91 payload places it elsewhere.
  if (!name) {
    name = cleanCustomerName(data.customer_name);
  }

  if (!name) {
    name = cleanCustomerName(data.contacts?.[0]?.profile?.name);
  }

  if (!name && messages?.[0]?.contacts?.[0]?.profile?.name) {
    name = cleanCustomerName(
      messages[0].contacts[0].profile.name
    );
  }

  return name || "WhatsApp Lead";
}

function getHubSpotDateValue() {
  const now = new Date();

  const utcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  return String(utcMidnight);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeURL(url) {
  if (!url) return "";

  try {
    const parsed = new URL(String(url));

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "";
    }

    return parsed.toString();
  } catch {
    return "";
  }
}

function parseJSON(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();

  return `{${keys
    .map(
      (key) =>
        JSON.stringify(key) + ":" + stableStringify(value[key])
    )
    .join(",")}}`;
}

// --------------------------------------------------
// TEMPLATE CATEGORY / SOURCE
// --------------------------------------------------

function getProfession(templateName) {
  const name = String(templateName || "").toLowerCase();

  if (name.includes("pharm")) {
    return "Pharmacy";
  }

  if (name.includes("diag")) {
    return "Healthcare Professional";
  }

  return "Doctor";
}

function getOfflineSource(templateName) {
  const name = String(templateName || "").toLowerCase();

  if (name.startsWith("purch")) {
    return "Purchased Data";
  }

  return "Data Mining";
}

// --------------------------------------------------
// MSG91 WEBHOOK PARSING
// --------------------------------------------------

function parseWebhookData(body) {
  let data = body;

  if (typeof data === "string") {
    data = parseJSON(data, {});
  }

  if (!data || typeof data !== "object") {
    data = {};
  }

  let messages = parseJSON(data.messages, []);

  if (!Array.isArray(messages)) {
    messages = [];
  }

  let button = parseJSON(data.button, {});

  if (!button || typeof button !== "object") {
    button = {};
  }

  // Sometimes button data is available inside messages.
  const messageButton = messages.find(
    (item) => item?.button || item?.interactive
  );

  if (
    (!button.text && !button.payload) &&
    messageButton?.button
  ) {
    button = messageButton.button;
  }

  if (
    (!button.text && !button.payload) &&
    messageButton?.interactive
  ) {
    const interactive = messageButton.interactive;

    button = {
      text:
        interactive?.button_reply?.title ||
        interactive?.list_reply?.title ||
        "",
      payload:
        interactive?.button_reply?.id ||
        interactive?.list_reply?.id ||
        "",
    };
  }

  const firstMessage = messages[0] || {};

  const phone =
    data.customerNumber ||
    data.customer_number ||
    firstMessage.from ||
    "";

  const templateName =
    data.templateName ||
    data.template_name ||
    "";

  const buttonText =
    button.text ||
    button.payload ||
    data.text ||
    "";

  const timestamp =
    firstMessage.timestamp ||
    data.ts ||
    data.requestedAt ||
    "";

  return {
    raw: data,
    items: messages,
    phone: normalizePhone(phone),
    customerName: getCustomerName(data, messages),
    templateName: String(templateName).trim(),
    buttonText: String(buttonText).trim(),
    buttonPayload: String(button.payload || "").trim(),
    timestamp,
  };
}

// --------------------------------------------------
// DEDUPLICATION
// --------------------------------------------------

function readProcessedEvents() {
  try {
    if (!fs.existsSync(PROCESSED_FILE)) {
      return {};
    }

    const content = fs.readFileSync(PROCESSED_FILE, "utf8");
    const parsed = JSON.parse(content);

    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    logError("Could not read deduplication file", error);
    return {};
  }
}

function writeProcessedEvents(events) {
  const temporaryFile = PROCESSED_FILE + ".tmp";

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(events, null, 2),
    "utf8"
  );

  fs.renameSync(temporaryFile, PROCESSED_FILE);
}

function cleanOldProcessedEvents(events) {
  const now = Date.now();

  for (const [key, value] of Object.entries(events)) {
    const createdAt = Number(value?.updatedAt || value?.createdAt || 0);

    if (
      !createdAt ||
      now - createdAt > DEDUPE_RETENTION_MS
    ) {
      delete events[key];
    }
  }

  return events;
}

function createButtonEventKey(data, buttonInfo) {
  const firstMessage = buttonInfo.items?.[0] || {};

  // Use the incoming button message ID first.
  // replyMsgId is the original outbound message ID, not the
  // unique incoming button-response ID.
  const eventId =
    firstMessage.id ||
    firstMessage.messageId ||
    firstMessage.message_id ||
    data.uuid ||
    data.messageId ||
    data.message_id ||
    data.replyMsgId;

  if (eventId) {
    return crypto
      .createHash("sha256")
      .update("MSG91:" + String(eventId))
      .digest("hex");
  }

  const fallback = {
    phone: buttonInfo.phone,
    templateName: buttonInfo.templateName,
    buttonText: buttonInfo.buttonText,
    timestamp: buttonInfo.timestamp || null,
    payload: data,
  };

  return crypto
    .createHash("sha256")
    .update(stableStringify(fallback))
    .digest("hex");
}

function isDuplicateEvent(eventKey) {
  const events = cleanOldProcessedEvents(readProcessedEvents());
  const existing = events[eventKey];

  if (!existing) {
    return false;
  }

  if (existing.status === "done") {
    return true;
  }

  if (
    existing.status === "processing" &&
    Date.now() - Number(existing.updatedAt || 0) <
      PROCESSING_LEASE_MS
  ) {
    return true;
  }

  return false;
}

function markEvent(eventKey, status) {
  const events = cleanOldProcessedEvents(readProcessedEvents());

  events[eventKey] = {
    status,
    createdAt: events[eventKey]?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  writeProcessedEvents(events);
}

// --------------------------------------------------
// MSG91 TEMPLATE FETCH
// --------------------------------------------------

async function fetchMSG91Template(templateName) {
  if (!MSG91_AUTHKEY) {
    throw new Error("MSG91_AUTHKEY is missing in environment variables");
  }

  logInfo("Fetching MSG91 template", {
    templateName,
  });

  const response = await axios.get(MSG91_TEMPLATE_URL, {
    timeout: 30000,
    headers: {
      authkey: MSG91_AUTHKEY,
      Accept: "application/json",
    },
  });

  const root = response.data;

  // Common response format: response.data.data
  let templates = [];

  if (Array.isArray(root?.data?.data)) {
    templates = root.data.data;
  } else if (Array.isArray(root?.data)) {
    templates = root.data;
  } else if (Array.isArray(root?.templates)) {
    templates = root.templates;
  } else if (Array.isArray(root)) {
    templates = root;
  }

  logInfo("MSG91 template API response received", {
    templateCount: templates.length,
  });

  const wantedName = String(templateName || "").toLowerCase();

  const matchedTemplate = templates.find(
    (item) =>
      String(item?.name || "").toLowerCase() === wantedName
  );

  if (!matchedTemplate) {
    logInfo("Template not found in MSG91 API", {
      requestedTemplate: templateName,
      availableTemplates: templates
        .slice(0, 20)
        .map((item) => item?.name),
    });

    return null;
  }

  const components = Array.isArray(matchedTemplate.components)
    ? matchedTemplate.components
    : [];

  const bodyComponent = components.find(
    (item) => item.type === "BODY"
  );

  const headerComponent = components.find(
    (item) => item.type === "HEADER"
  );

  const buttonsComponent = components.find(
    (item) => item.type === "BUTTONS"
  );

  const headerImage =
    headerComponent?.format === "IMAGE"
      ? headerComponent?.example?.header_handle?.[0] || ""
      : "";

  const buttons = Array.isArray(buttonsComponent?.buttons)
    ? buttonsComponent.buttons
    : [];

  const result = {
    name: matchedTemplate.name || templateName,
    language: matchedTemplate.language || "",
    category: matchedTemplate.category || "",
    body: bodyComponent?.text || "",
    headerImage,
    buttons,
  };

  logInfo("MSG91 template parsed", {
    name: result.name,
    language: result.language,
    category: result.category,
    hasBody: Boolean(result.body),
    hasHeaderImage: Boolean(result.headerImage),
    buttonCount: result.buttons.length,
  });

  return result;
}

// --------------------------------------------------
// HUBSPOT CONTACT SEARCH
// --------------------------------------------------

async function findHubSpotContact(phone) {
  const normalized = normalizePhone(phone);

  if (!normalized) {
    return null;
  }

  const phoneVariants = [
    "+" + normalized,
    normalized,
  ];

  for (const phoneValue of phoneVariants) {
    try {
      const response = await hubspot.post(
        "/crm/v3/objects/contacts/search",
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "phone",
                  operator: "EQ",
                  value: phoneValue,
                },
              ],
            },
          ],
          properties: [
            "firstname",
            "lastname",
            "phone",
            "email",
            "wa_creative",
            "date_whatsapp",
          ],
          limit: 1,
        }
      );

      if (response.data?.results?.length) {
        const contact = response.data.results[0];

        logInfo("Existing HubSpot contact found", {
          contactId: contact.id,
          phone: maskPhone(phone),
          existingName: contact.properties?.firstname || "",
        });

        return contact;
      }
    } catch (error) {
      logError(
        `HubSpot contact search failed for ${phoneValue}`,
        error
      );
    }
  }

  logInfo("No existing HubSpot contact found", {
    phone: maskPhone(phone),
  });

  return null;
}

// --------------------------------------------------
// HUBSPOT CONTACT CREATE
// --------------------------------------------------

async function createNewContact(phone, customerName, templateName) {
  const normalizedPhone = normalizePhone(phone);
  const hubspotPhone = formatHubSpotPhone(phone);

  if (!normalizedPhone || !hubspotPhone) {
    throw new Error("Cannot create HubSpot contact: invalid phone number");
  }

  const finalName = cleanCustomerName(customerName) || "WhatsApp Lead";

  const properties = {
    firstname: finalName,
    phone: hubspotPhone,
    email: `${normalizedPhone}@noemail.com`,
    wa_creative: templateName || "",
    date_whatsapp: getHubSpotDateValue(),
    profession_category: getProfession(templateName),
    custom_offline_sources_trail: getOfflineSource(templateName),
  };

  logInfo("Creating new HubSpot contact", {
    customerName: finalName,
    phone: maskPhone(phone),
    templateName,
    profession: properties.profession_category,
    source: properties.custom_offline_sources_trail,
  });

  const response = await hubspot.post(
    "/crm/v3/objects/contacts",
    {
      properties,
    }
  );

  logInfo("HubSpot contact created successfully", {
    contactId: response.data.id,
    customerName: finalName,
    phone: maskPhone(phone),
  });

  return response.data;
}

// --------------------------------------------------
// HUBSPOT EXISTING CONTACT UPDATE
// --------------------------------------------------

async function updateExistingContact(contactId, templateName) {
  const properties = {
    wa_creative: templateName || "",
    date_whatsapp: getHubSpotDateValue(),
  };

  logInfo("Updating existing HubSpot contact", {
    contactId,
    templateName,
    fields: Object.keys(properties),
  });

  const response = await hubspot.patch(
    `/crm/v3/objects/contacts/${contactId}`,
    {
      properties,
    }
  );

  logInfo("Existing HubSpot contact updated", {
    contactId,
  });

  return response.data;
}

// --------------------------------------------------
// HUBSPOT NOTE HTML
// --------------------------------------------------

function buildNoteHTML(buttonInfo, template) {
  const buttonNames = (template?.buttons || [])
    .map((button) => button.text || button.type || "")
    .filter(Boolean)
    .join(" | ");

  const imageURL = safeURL(template?.headerImage);

  // Convert newlines into <br> because HubSpot may not preserve
  // white-space: pre-wrap in note rendering.
  const templateBody = template?.body
    ? escapeHTML(template.body).replace(/\r\n|\r|\n/g, "<br>")
    : "Template message not available";

  return `
    <div style="
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      color: #333333;
      line-height: 1.6;
    ">

      <h3 style="
        font-size: 16px;
        font-weight: 600;
        margin: 0 0 12px 0;
        color: #222222;
      ">
        WhatsApp Button Response
      </h3>

      <p style="margin: 4px 0;">
        <strong>Button:</strong>
        ${escapeHTML(buttonInfo.buttonText)}
      </p>

      <p style="margin: 4px 0;">
        <strong>Template:</strong>
        ${escapeHTML(buttonInfo.templateName)}
      </p>

      <p style="margin: 4px 0;">
        <strong>Source:</strong>
        MSG91 WhatsApp
      </p>

      <hr style="
        border: 0;
        border-top: 1px solid #dddddd;
        margin: 14px 0;
      ">

      <h4 style="
        font-size: 14px;
        font-weight: 600;
        margin: 0 0 8px 0;
        color: #222222;
      ">
        WhatsApp Template Message
      </h4>

      <div style="
        font-size: 14px;
        line-height: 1.6;
        word-break: break-word;
        margin-bottom: 14px;
      ">
        ${templateBody}
      </div>

      ${
        imageURL
          ? `
            <h4 style="
              font-size: 14px;
              font-weight: 600;
              margin: 12px 0 8px 0;
              color: #222222;
            ">
              WhatsApp Template Header Image
            </h4>

            <img
              src="${escapeHTML(imageURL)}"
              width="250"
              style="
                width: 250px;
                max-width: 100%;
                height: auto;
                display: block;
                border: 0;
                border-radius: 5px;
                margin-bottom: 14px;
              "
            >
          `
          : ""
      }

      ${
        buttonNames
          ? `
            <h4 style="
              font-size: 14px;
              font-weight: 600;
              margin: 12px 0 6px 0;
              color: #222222;
            ">
              Template Buttons
            </h4>

            <p style="
              margin: 0;
              font-size: 13px;
              line-height: 1.6;
            ">
              ${escapeHTML(buttonNames)}
            </p>
          `
          : ""
      }

    </div>
  `;
}

// --------------------------------------------------
// HUBSPOT NOTE CREATE + CONTACT ASSOCIATION
// --------------------------------------------------

async function createHubSpotNote(contactId, buttonInfo, template) {
  const noteBody = buildNoteHTML(buttonInfo, template);

  const notePayload = {
    properties: {
      hs_note_body: noteBody,
      hs_timestamp: new Date().toISOString(),
    },
    associations: [
      {
        to: {
          id: String(contactId),
        },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 202,
          },
        ],
      },
    ],
  };

  logInfo("Creating HubSpot Note", {
    contactId,
    button: buttonInfo.buttonText,
    template: buttonInfo.templateName,
    hasTemplateBody: Boolean(template?.body),
    hasHeaderImage: Boolean(template?.headerImage),
  });

  const response = await hubspot.post(
    "/crm/v3/objects/notes",
    notePayload
  );

  logInfo("HubSpot Note created successfully", {
    noteId: response.data.id,
    contactId,
  });

  return response.data;
}

// --------------------------------------------------
// MAIN WEBHOOK PROCESS
// --------------------------------------------------

async function processWebhook(body) {
  const buttonInfo = parseWebhookData(body);
  const data = buttonInfo.raw;

  logInfo("MSG91 webhook received", {
    customerName: buttonInfo.customerName,
    phone: maskPhone(buttonInfo.phone),
    templateName: buttonInfo.templateName,
    buttonText: buttonInfo.buttonText,
    integratedNumber: data.integratedNumber || "",
    messageCount: buttonInfo.items.length,
    messageId: buttonInfo.items?.[0]?.id || "",
    webhookType: data.webhookType || "",
  });

  // Target number validation
  const integratedNumber = normalizePhone(data.integratedNumber);

  if (integratedNumber && integratedNumber !== TARGET_NUMBER) {
    logInfo("Webhook ignored: integrated number does not match", {
      received: maskPhone(integratedNumber),
      expected: maskPhone(TARGET_NUMBER),
    });

    return {
      ignored: true,
      reason: "Integrated number mismatch",
    };
  }

  if (!buttonInfo.phone) {
    throw new Error("Customer phone number missing in MSG91 payload");
  }

  if (!buttonInfo.buttonText) {
    logInfo("No button text found; webhook ignored", {
      phone: maskPhone(buttonInfo.phone),
      templateName: buttonInfo.templateName,
    });

    return {
      ignored: true,
      reason: "No button response found",
    };
  }

  const eventKey = createButtonEventKey(data, buttonInfo);

  if (processingEvents.has(eventKey) || isDuplicateEvent(eventKey)) {
    logInfo("Duplicate button event ignored", {
      eventKey,
      phone: maskPhone(buttonInfo.phone),
      button: buttonInfo.buttonText,
    });

    return {
      duplicate: true,
    };
  }

  processingEvents.add(eventKey);
  markEvent(eventKey, "processing");

  try {
    // 1. Search existing HubSpot contact.
    const existingContact = await findHubSpotContact(
      buttonInfo.phone
    );

    let contact;

    // 2. Create new contact or update existing contact.
    if (existingContact) {
      contact = await updateExistingContact(
        existingContact.id,
        buttonInfo.templateName
      );
    } else {
      contact = await createNewContact(
        buttonInfo.phone,
        buttonInfo.customerName,
        buttonInfo.templateName
      );
    }

    // 3. Fetch actual approved template definition from MSG91.
    let template = null;

    if (buttonInfo.templateName) {
      try {
        template = await fetchMSG91Template(
          buttonInfo.templateName
        );
      } catch (error) {
        logError("MSG91 template fetch failed; Note will be created without template details", error);
      }
    }

    // 4. Create one Note for this unique button response.
    await createHubSpotNote(
      contact.id,
      buttonInfo,
      template
    );

    // 5. Mark event completed.
    markEvent(eventKey, "done");

    logInfo("Webhook processing completed successfully", {
      contactId: contact.id,
      customerName: buttonInfo.customerName,
      phone: maskPhone(buttonInfo.phone),
      templateName: buttonInfo.templateName,
      button: buttonInfo.buttonText,
    });

    return {
      success: true,
      contactId: contact.id,
      customerName: buttonInfo.customerName,
    };
  } catch (error) {
    // Remove processing state so MSG91 retry can try again.
    markEvent(eventKey, "failed");

    logError("Webhook processing failed", error);

    throw error;
  } finally {
    processingEvents.delete(eventKey);
  }
}

// --------------------------------------------------
// EXPRESS ROUTES
// --------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).send("MSG91 WhatsApp to HubSpot webhook is running.");
});

app.post("/webhook/msg91", async (req, res) => {
  try {
    logInfo("Incoming request received", {
      method: req.method,
      path: req.path,
      contentType: req.headers["content-type"] || "",
    });

    const result = await processWebhook(req.body);

    return res.status(200).json({
      status: "success",
      message: "Webhook processed",
      result,
    });
  } catch (error) {
    logError("Webhook route error", error);

    return res.status(500).json({
      status: "error",
      message: error.message || "Webhook processing failed",
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log("-------------------------------------------");
  console.log("MSG91 → HubSpot webhook server is running");
  console.log("PORT:", PORT);
  console.log("TARGET NUMBER:", TARGET_NUMBER);
  console.log("WEBHOOK: /webhook/msg91");
  console.log("HUBSPOT TOKEN:", HUBSPOT_TOKEN ? "Loaded" : "MISSING");
  console.log("MSG91 AUTHKEY:", MSG91_AUTHKEY ? "Loaded" : "MISSING");
  console.log("-------------------------------------------");
});
