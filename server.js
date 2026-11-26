
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 3000;

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const MSG91_AUTHKEY = process.env.MSG91_AUTHKEY;

const TARGET_NUMBER = "917088000907";

const HUBSPOT_BASE_URL = "https://api.hubapi.com";

const MSG91_TEMPLATE_URL =
  "https://control.msg91.com/api/v5/whatsapp/get-template-plugins/";

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

const msg91 = axios.create({
  timeout: 30000,
  headers: {
    authkey: MSG91_AUTHKEY,
    Accept: "application/json",
  },
});

// =====================================================
// LOGGING
// =====================================================

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
    console.error("API RESPONSE:", error.response.data);
  } else {
    console.error("ERROR MESSAGE:", error?.message || error);
  }
}

// =====================================================
// GENERAL HELPERS
// =====================================================

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

function normalizePhone(phone) {
  if (!phone) return "";

  let number = String(phone).replace(/\D/g, "");

  if (number.startsWith("00")) {
    number = number.substring(2);
  }

  if (number.startsWith("0")) {
    number = number.substring(1);
  }

  if (number.length === 10) {
    number = "91" + number;
  }

  return number;
}

function formatHubSpotPhone(phone) {
  const number = normalizePhone(phone);
  return number ? "+" + number : "";
}

function getPhoneVariants(phone) {
  const number = normalizePhone(phone);

  if (!number) return [];

  const variants = new Set([
    number,
    "+" + number,
  ]);

  if (number.startsWith("91") && number.length === 12) {
    const local = number.substring(2);

    variants.add(local);
    variants.add("0" + local);
  }

  return [...variants];
}

function maskPhone(phone) {
  const number = normalizePhone(phone);

  if (!number) return "N/A";

  return number.length > 4
    ? number.slice(0, 2) + "******" + number.slice(-4)
    : "******";
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

function escapeHTML(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeURL(value) {
  if (!value) return "";

  try {
    const parsed = new URL(String(value));

    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:"
    ) {
      return "";
    }

    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();

  let timestamp;

  if (/^\d+$/.test(String(value))) {
    timestamp = Number(value);

    if (timestamp < 100000000000) {
      timestamp *= 1000;
    }
  } else {
    timestamp = new Date(value).getTime();
  }

  if (!Number.isFinite(timestamp)) {
    return new Date().toISOString();
  }

  return new Date(timestamp).toISOString();
}

function getHubSpotDateValue() {
  const date = new Date();

  const utcMidnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );

  return String(utcMidnight);
}

// =====================================================
// PROFESSION / SOURCE MAPPING
// =====================================================

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

// =====================================================
// MSG91 WEBHOOK PARSING
// =====================================================

function getMessageItems(data) {
  let messages = parseJSON(data?.messages, []);

  if (Array.isArray(messages)) {
    return messages;
  }

  if (messages && typeof messages === "object") {
    return [messages];
  }

  const nestedData = parseJSON(data?.data, {});

  if (Array.isArray(nestedData)) {
    return nestedData;
  }

  if (nestedData && typeof nestedData === "object") {
    if (Array.isArray(nestedData.messages)) {
      return nestedData.messages;
    }

    return [nestedData];
  }

  return [];
}

function getCustomerName(data, messages) {
  let name =
    cleanCustomerName(data.customerName) ||
    cleanCustomerName(data.customer_name) ||
    cleanCustomerName(data.contacts?.[0]?.profile?.name) ||
    cleanCustomerName(messages?.[0]?.contacts?.[0]?.profile?.name);

  return name || "WhatsApp Lead";
}

function extractButtonInfo(data) {
  const items = getMessageItems(data);

  const customerNumber =
    data.customerNumber ||
    data.customer_number ||
    data.from ||
    data.mobile ||
    data.phone ||
    items.find(item => item?.from)?.from ||
    items.find(item => item?.customerNumber)?.customerNumber ||
    "";

  const templateName =
    data.templateName ||
    data.template_name ||
    data.template ||
    data.data?.templateName ||
    "";

  const templateLanguage =
    data.templateLanguage ||
    data.template_language ||
    data.language ||
    data.data?.templateLanguage ||
    "en";

  let buttonText = "";
  let buttonPayload = "";

  for (const item of items) {
    const parsedButton = parseJSON(item.button, {});

    if (parsedButton && typeof parsedButton === "object") {
      buttonText =
        parsedButton.text ||
        parsedButton.title ||
        parsedButton.payload ||
        "";

      buttonPayload =
        parsedButton.payload ||
        parsedButton.id ||
        "";
    }

    if (!buttonText && item.interactive) {
      const reply =
        item.interactive.button_reply ||
        item.interactive.list_reply;

      if (reply) {
        buttonText = reply.title || reply.id || "";
        buttonPayload = reply.id || "";
      }
    }

    if (!buttonText && item.button_reply) {
      buttonText =
        item.button_reply.title ||
        item.button_reply.text ||
        item.button_reply.id ||
        "";

      buttonPayload = item.button_reply.id || "";
    }

    if (!buttonText && item.buttonResponse) {
      buttonText =
        item.buttonResponse.text ||
        item.buttonResponse.title ||
        item.buttonResponse ||
        "";
    }

    if (!buttonText) {
      buttonText =
        item.button_text ||
        item.buttonText ||
        (typeof item.button === "string" ? item.button : "");
    }

    if (buttonText) break;
  }

  if (!buttonText) {
    const rootButton = parseJSON(data.button, {});

    if (rootButton && typeof rootButton === "object") {
      buttonText =
        rootButton.text ||
        rootButton.title ||
        rootButton.payload ||
        "";

      buttonPayload =
        rootButton.payload ||
        rootButton.id ||
        "";
    } else if (typeof rootButton === "string") {
      buttonText = rootButton;
    }
  }

  const rawTimestamp =
    data.timestamp ||
    data.ts ||
    data.requestedAt ||
    items.find(item => item?.timestamp)?.timestamp ||
    "";

  const messageId =
    items.find(item => item?.id)?.id ||
    items.find(item => item?.messageId)?.messageId ||
    data.messageId ||
    data.message_id ||
    data.eventId ||
    data.event_id ||
    "";

  return {
    raw: data,
    items,
    phone: normalizePhone(customerNumber),
    customerName: getCustomerName(data, items),
    templateName: String(templateName).trim(),
    templateLanguage: String(templateLanguage).trim(),
    buttonText: String(buttonText || "").trim(),
    buttonPayload: String(buttonPayload || "").trim(),
    rawTimestamp,
    timestamp: normalizeTimestamp(rawTimestamp),
    messageId: String(messageId || ""),
  };
}

// =====================================================
// IMAGE URL EXTRACTION
// =====================================================

function extractImageURL(data, template) {
  const candidates = [];

  function scan(obj, parentKey = "") {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach(item => scan(item, parentKey));
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();

      if (typeof value === "string") {
        if (
          /image.?url|media.?url|header.?image|image.?link|thumbnail.?url/.test(
            lowerKey
          )
        ) {
          candidates.push(value);
        }

        if (
          ["url", "link", "src"].includes(lowerKey) &&
          /image|media|header|attachment/.test(parentKey)
        ) {
          candidates.push(value);
        }
      }

      if (value && typeof value === "object") {
        scan(value, lowerKey);
      }
    }
  }

  scan(data);

  if (template?.headerImage) {
    candidates.push(template.headerImage);
  }

  for (const candidate of candidates) {
    const url = safeURL(candidate);

    if (url) return url;
  }

  return "";
}

// =====================================================
// DEDUPLICATION STORAGE
// =====================================================

function readProcessedEvents() {
  try {
    if (!fs.existsSync(PROCESSED_FILE)) {
      return {};
    }

    const content = fs.readFileSync(PROCESSED_FILE, "utf8");
    const parsed = JSON.parse(content || "{}");

    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    logError("Deduplication file read error", error);
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

  for (const [key, item] of Object.entries(events)) {
    const updatedAt = Number(
      item?.updatedAt || item?.createdAt || 0
    );

    if (
      !updatedAt ||
      now - updatedAt > DEDUPE_RETENTION_MS
    ) {
      delete events[key];
    }
  }

  return events;
}

function createButtonEventKey(data, buttonInfo) {
  if (buttonInfo.messageId) {
    return crypto
      .createHash("sha256")
      .update("MSG91:" + buttonInfo.messageId)
      .digest("hex");
  }

  const fallback = {
    phone: buttonInfo.phone,
    templateName: buttonInfo.templateName,
    buttonText: buttonInfo.buttonText,
    timestamp: buttonInfo.rawTimestamp || null,
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(fallback))
    .digest("hex");
}

function reserveButtonEvent(eventKey) {
  if (processingEvents.has(eventKey)) {
    return false;
  }

  const events = cleanOldProcessedEvents(readProcessedEvents());
  const existing = events[eventKey];

  if (existing?.status === "done") {
    writeProcessedEvents(events);
    return false;
  }

  if (
    existing?.status === "processing" &&
    Date.now() - Number(existing.updatedAt || 0) <
      PROCESSING_LEASE_MS
  ) {
    return false;
  }

  events[eventKey] = {
    status: "processing",
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  writeProcessedEvents(events);
  processingEvents.add(eventKey);

  return true;
}

function markEvent(eventKey, status, noteId = "") {
  const events = cleanOldProcessedEvents(readProcessedEvents());

  events[eventKey] = {
    status,
    noteId: String(noteId || ""),
    createdAt: events[eventKey]?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  writeProcessedEvents(events);
  processingEvents.delete(eventKey);
}

function releaseButtonEvent(eventKey) {
  const events = readProcessedEvents();

  if (events[eventKey]?.status === "processing") {
    delete events[eventKey];
    writeProcessedEvents(events);
  }

  processingEvents.delete(eventKey);
}

// =====================================================
// MSG91 TEMPLATE FETCH
// =====================================================

async function fetchMSG91Templates() {
  if (!MSG91_AUTHKEY) {
    throw new Error("MSG91_AUTHKEY is missing");
  }

  const response = await msg91.get(MSG91_TEMPLATE_URL, {
    params: {
      plugin: "clevertap",
      number: TARGET_NUMBER,
    },
  });

  const root = response.data;

  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.data?.data)) return root.data.data;
  if (Array.isArray(root?.data)) return root.data;
  if (Array.isArray(root?.templates)) return root.templates;

  logInfo("Unexpected MSG91 template response", {
    response: JSON.stringify(root).slice(0, 1500),
  });

  return [];
}

async function getMSG91Template(templateName, language) {
  if (!templateName) return null;

  const templates = await fetchMSG91Templates();

  const matchedTemplate = templates.find(item => {
    const sameName =
      String(item?.name || "").toLowerCase() ===
      String(templateName).toLowerCase();

    const itemLanguage = String(item?.language || "").toLowerCase();

    const sameLanguage =
      !language ||
      !itemLanguage ||
      itemLanguage === String(language).toLowerCase();

    return sameName && sameLanguage;
  });

  if (!matchedTemplate) {
    logInfo("MSG91 template not found", {
      templateName,
    });

    return null;
  }

  const components = Array.isArray(matchedTemplate.components)
    ? matchedTemplate.components
    : [];

  const bodyComponent = components.find(
    item => item.type === "BODY"
  );

  const headerComponent = components.find(
    item => item.type === "HEADER"
  );

  const footerComponent = components.find(
    item => item.type === "FOOTER"
  );

  const buttonsComponent = components.find(
    item => item.type === "BUTTONS"
  );

  const headerImage =
    headerComponent?.format === "IMAGE"
      ? headerComponent?.example?.header_handle?.[0] || ""
      : "";

  const result = {
    name: matchedTemplate.name || templateName,
    language: matchedTemplate.language || language || "",
    category: matchedTemplate.category || "",
    status: matchedTemplate.status || "",
    body: bodyComponent?.text || "",
    headerFormat: headerComponent?.format || "",
    headerImage,
    footer: footerComponent?.text || "",
    buttons: Array.isArray(buttonsComponent?.buttons)
      ? buttonsComponent.buttons
      : [],
  };

  logInfo("MSG91 template parsed", {
    name: result.name,
    hasBody: Boolean(result.body),
    hasHeaderImage: Boolean(result.headerImage),
    buttonCount: result.buttons.length,
  });

  return result;
}

// =====================================================
// HUBSPOT CONTACT SEARCH
// =====================================================

async function findHubSpotContact(phone) {
  const phoneVariants = getPhoneVariants(phone);

  if (!phoneVariants.length) return null;

  const filters = phoneVariants.map(number => ({
    propertyName: "phone",
    operator: "EQ",
    value: number,
  }));

  const response = await hubspot.post(
    "/crm/v3/objects/contacts/search",
    {
      filterGroups: filters.map(filter => ({
        filters: [filter],
      })),
      properties: [
        "firstname",
        "lastname",
        "phone",
        "email",
        "date_whatsapp",
        "wa_creative",
        "profession_category",
        "custom_offline_sources_trail",
      ],
      limit: 1,
    }
  );

  return response.data.results?.[0] || null;
}

// =====================================================
// HUBSPOT CONTACT CREATE
// =====================================================

async function createNewContact(phone, customerName, templateName) {
  const normalizedPhone = normalizePhone(phone);
  const hubspotPhone = formatHubSpotPhone(phone);

  if (!normalizedPhone || !hubspotPhone) {
    throw new Error("Cannot create HubSpot contact: invalid phone");
  }

  const finalName =
    cleanCustomerName(customerName) || "WhatsApp Lead";

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
  });

  const response = await hubspot.post(
    "/crm/v3/objects/contacts",
    { properties }
  );

  logInfo("HubSpot contact created", {
    contactId: response.data.id,
  });

  return response.data;
}

// =====================================================
// HUBSPOT EXISTING CONTACT UPDATE
// =====================================================

async function updateExistingContact(contactId, templateName) {
  const properties = {
    wa_creative: templateName || "",
    date_whatsapp: getHubSpotDateValue(),
  };

  const response = await hubspot.patch(
    `/crm/v3/objects/contacts/${contactId}`,
    { properties }
  );

  logInfo("Existing HubSpot contact updated", {
    contactId,
  });

  return response.data;
}

// =====================================================
// HUBSPOT NOTE HTML
// =====================================================

function buildNoteHTML(buttonInfo, template, imageURL) {
  const messageBody =
    template?.body ||
    buttonInfo.message ||
    "Message not available";

  const safeButton = escapeHTML(buttonInfo.buttonText);
  const safeMessage = escapeHTML(messageBody).replace(
    /\r\n|\r|\n/g,
    "<br>"
  );

  const safeImage = safeURL(imageURL);

  return `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#303030;line-height:1.6;">

  <div style="margin-bottom:12px;">
    <strong>Clicked Button:</strong>
    ${safeButton}
  </div>

  <div style="margin-bottom:12px;">
    <strong>Message:</strong>
    <div style="margin-top:5px;">${safeMessage}</div>
  </div>

  ${
    safeImage
      ? `
      <div style="margin-top:12px;">
        <img
          src="${escapeHTML(safeImage)}"
          alt="WhatsApp Campaign Image"
          style="display:block;max-width:100%;height:auto;border:0;"
        />
      </div>
      `
      : ""
  }

</div>
`;
}

// =====================================================
// CREATE HUBSPOT NOTE
// =====================================================

async function createHubSpotNote(
  contactId,
  buttonInfo,
  template,
  imageURL,
  eventKey
) {
  const noteBody =
    buildNoteHTML(buttonInfo, template, imageURL) +
    `<!-- MSG91_EVENT_ID:${eventKey} -->`;

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
    hasMessage: Boolean(template?.body || buttonInfo.message),
    hasImage: Boolean(imageURL),
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

// =====================================================
// HUBSPOT NOTE DUPLICATE CHECK
// =====================================================

async function noteAlreadyExists(contactId, eventKey) {
  let after = undefined;
  let pages = 0;

  while (pages < 5) {
    const params = { limit: 100 };

    if (after) {
      params.after = after;
    }

    const response = await hubspot.get(
      `/crm/v4/objects/contacts/${contactId}/associations/notes`,
      { params }
    );

    const results = response.data.results || [];

    for (const item of results) {
      const noteId = item.toObjectId || item.id;

      if (!noteId) continue;

      const noteResponse = await hubspot.get(
        `/crm/v3/objects/notes/${noteId}`,
        {
          params: {
            properties: "hs_note_body",
          },
        }
      );

      const body =
        noteResponse.data?.properties?.hs_note_body || "";

      if (body.includes(`MSG91_EVENT_ID:${eventKey}`)) {
        return true;
      }
    }

    after = response.data.paging?.next?.after;

    if (!after) break;

    pages++;
  }

  return false;
}

// =====================================================
// MAIN WEBHOOK PROCESS
// =====================================================

async function processWebhook(body) {
  const data =
    typeof body === "string"
      ? parseJSON(body, {})
      : body || {};

  const buttonInfo = extractButtonInfo(data);

  logInfo("MSG91 webhook received", {
    customerName: buttonInfo.customerName,
    phone: maskPhone(buttonInfo.phone),
    templateName: buttonInfo.templateName,
    buttonText: buttonInfo.buttonText,
    messageId: buttonInfo.messageId,
  });

  // Integrated number validation
  const receivedTarget =
    data.integrated_number ||
    data.integratedNumber ||
    data.whatsapp_number ||
    data.whatsappNumber ||
    data.number ||
    "";

  if (
    receivedTarget &&
    normalizePhone(receivedTarget) !== normalizePhone(TARGET_NUMBER)
  ) {
    return {
      ignored: true,
      reason: "Integrated number mismatch",
    };
  }

  // Phone validation
  if (!buttonInfo.phone) {
    return {
      ignored: true,
      reason: "Customer phone missing",
    };
  }

  // Button response validation
  if (!buttonInfo.buttonText) {
    return {
      ignored: true,
      reason: "No button response found",
    };
  }

  // Template name validation
  if (!buttonInfo.templateName) {
    return {
      ignored: true,
      reason: "Template name missing",
    };
  }

  // Ignore STOP requests
  if (
    buttonInfo.buttonText.toLowerCase().trim() === "stop"
  ) {
    return {
      ignored: true,
      reason: "STOP message",
    };
  }

  // Unique event key
  const eventKey = createButtonEventKey(data, buttonInfo);

  // Prevent duplicate event
  if (!reserveButtonEvent(eventKey)) {
    logInfo("Duplicate button event ignored", {
      eventKey,
      phone: maskPhone(buttonInfo.phone),
      button: buttonInfo.buttonText,
    });

    return {
      duplicate: true,
      message: "Duplicate event - Note not created",
    };
  }

  try {
    // 1. Search existing HubSpot contact
    const existingContact = await findHubSpotContact(
      buttonInfo.phone
    );

    // 2. Create or update contact
    let contact;

    if (existingContact) {
      contact = await updateExistingContact(
        existingContact.id,
        buttonInfo.templateName
      );

      contact.id = existingContact.id;
    } else {
      contact = await createNewContact(
        buttonInfo.phone,
        buttonInfo.customerName,
        buttonInfo.templateName
      );
    }

    // 3. Check HubSpot timeline for duplicate note
    const alreadyExists = await noteAlreadyExists(
      contact.id,
      eventKey
    );

    if (alreadyExists) {
      markEvent(eventKey, "done");

      return {
        success: true,
        duplicate: true,
        contactId: contact.id,
        message: "Note already exists",
      };
    }

    // 4. Fetch actual MSG91 template
    let template = null;

    try {
      template = await getMSG91Template(
        buttonInfo.templateName,
        buttonInfo.templateLanguage
      );
    } catch (error) {
      logError("MSG91 template fetch failed", error);
    }

    // 5. Resolve image URL from webhook/template response
    const imageURL = extractImageURL(data, template);

    logInfo("Image detection result", {
      imageFound: Boolean(imageURL),
      imageURL: imageURL ? "Available" : "Not available",
      headerFormat: template?.headerFormat || "",
    });

    // 6. Create only one HubSpot Note
    const note = await createHubSpotNote(
      contact.id,
      buttonInfo,
      template,
      imageURL,
      eventKey
    );

    // 7. Mark event completed
    markEvent(eventKey, "done", note.id);

    logInfo("Webhook processing completed", {
      contactId: contact.id,
      noteId: note.id,
      button: buttonInfo.buttonText,
    });

    return {
      success: true,
      contactId: contact.id,
      noteId: note.id,
      imageFound: Boolean(imageURL),
    };
  } catch (error) {
    markEvent(eventKey, "failed");

    logError("Webhook processing failed", error);

    throw error;
  } finally {
    processingEvents.delete(eventKey);
  }
}

// =====================================================
// EXPRESS ROUTES
// =====================================================

app.get("/", (req, res) => {
  res.status(200).send(
    "MSG91 WhatsApp to HubSpot webhook is running."
  );
});

app.post("/webhook/msg91", async (req, res) => {
  try {
    const result = await processWebhook(req.body);

    return res.status(200).json({
      status: "success",
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

// =====================================================
// START SERVER
// =====================================================

if (!HUBSPOT_TOKEN) {
  console.error("WARNING: HUBSPOT_TOKEN missing");
}

if (!MSG91_AUTHKEY) {
  console.error("WARNING: MSG91_AUTHKEY missing");
}

app.listen(PORT, () => {
  console.log("-------------------------------------------");
  console.log("MSG91 -> HubSpot webhook server running");
  console.log("PORT:", PORT);
  console.log("TARGET NUMBER:", TARGET_NUMBER);
  console.log("WEBHOOK: /webhook/msg91");
  console.log("HUBSPOT TOKEN:", HUBSPOT_TOKEN ? "Loaded" : "MISSING");
  console.log("MSG91 AUTHKEY:", MSG91_AUTHKEY ? "Loaded" : "MISSING");
  console.log("-------------------------------------------");
});
