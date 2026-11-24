
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 3000;

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const MSG91_AUTHKEY = process.env.MSG91_AUTHKEY;

// MSG91 Integrated WhatsApp Number
const TARGET_NUMBER = "917088000907";

const HUBSPOT_BASE_URL = "https://api.hubapi.com";

const MSG91_TEMPLATE_URL =
  "https://control.msg91.com/api/v5/whatsapp/get-template-plugins/";

const HUBSPOT_HEADERS = {
  Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  "Content-Type": "application/json",
};

const MSG91_HEADERS = {
  authkey: MSG91_AUTHKEY,
  Accept: "application/json",
};

const DEDUPE_FILE = path.join(
  __dirname,
  "processed_button_events.json"
);

const DEDUPE_RETENTION_DAYS = 7;
const PROCESSING_LOCK_MS = 5 * 60 * 1000;

const processingEvents = new Set();

// =====================================================
// BASIC HELPERS
// =====================================================

function parseJSON(value) {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizePhone(phone) {
  if (!phone) return "";

  let number = String(phone).replace(/\D/g, "");

  if (number.startsWith("0")) {
    number = number.substring(1);
  }

  if (number.length === 10) {
    number = "91" + number;
  }

  return number;
}

// HubSpot E.164 phone format
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
    const withoutCountryCode = number.substring(2);

    variants.add(withoutCountryCode);
    variants.add("+91" + withoutCountryCode);
  }

  return [...variants];
}

function escapeHTML(value) {
  return String(value ?? "")
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

    return parsed.href;
  } catch {
    return "";
  }
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();

  let date;

  if (/^\d+$/.test(String(value))) {
    let timestamp = Number(value);

    if (timestamp < 100000000000) {
      timestamp *= 1000;
    }

    date = new Date(timestamp);
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

function getHubSpotDateValue() {
  const date = new Date();

  date.setUTCHours(0, 0, 0, 0);

  return String(date.getTime());
}

// =====================================================
// DEDUPLICATION STORAGE
// =====================================================

function readDedupeStore() {
  try {
    if (!fs.existsSync(DEDUPE_FILE)) {
      return {};
    }

    const content = fs.readFileSync(DEDUPE_FILE, "utf8");

    return JSON.parse(content || "{}");
  } catch (error) {
    console.error("Dedupe file read error:", error.message);
    return {};
  }
}

function saveDedupeStore(store) {
  const tempFile = DEDUPE_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(store, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, DEDUPE_FILE);
}

function cleanupDedupeStore(store) {
  const cutoff =
    Date.now() -
    DEDUPE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const [key, item] of Object.entries(store)) {
    if (!item || Number(item.updatedAt || 0) < cutoff) {
      delete store[key];
    }
  }

  return store;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();

    return (
      "{" +
      keys
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            stableStringify(value[key])
        )
        .join(",") +
      "}"
    );
  }

  return JSON.stringify(value);
}

// =====================================================
// UNIQUE BUTTON EVENT KEY
// =====================================================

function createButtonEventKey(data, buttonInfo) {
  // IMPORTANT:
  // MSG91 sends messages as a JSON STRING.
  // We use the parsed messages[0].id from buttonInfo.items.

  const firstMessage = buttonInfo.items?.[0] || {};

  const eventId =
    firstMessage.id ||
    firstMessage.messageId ||
    firstMessage.message_id ||
    data.uuid ||
    data.messageId ||
    data.message_id ||
    data.replyMsgId;

  // Prefer actual incoming button message ID.
  if (eventId) {
    return crypto
      .createHash("sha256")
      .update("MSG91:" + String(eventId))
      .digest("hex");
  }

  // Fallback for payloads without a unique message ID.
  const fallback = {
    phone: buttonInfo.phone,
    templateName: buttonInfo.templateName,
    buttonText: buttonInfo.buttonText,
    timestamp: buttonInfo.rawTimestamp || null,
    payload: data,
  };

  return crypto
    .createHash("sha256")
    .update(stableStringify(fallback))
    .digest("hex");
}

function reserveButtonEvent(eventKey) {
  if (processingEvents.has(eventKey)) {
    return false;
  }

  const store = cleanupDedupeStore(readDedupeStore());

  const existing = store[eventKey];

  if (existing && existing.status === "done") {
    saveDedupeStore(store);
    return false;
  }

  if (existing && existing.status === "processing") {
    const age = Date.now() - Number(existing.updatedAt || 0);

    if (age < PROCESSING_LOCK_MS) {
      saveDedupeStore(store);
      return false;
    }
  }

  store[eventKey] = {
    status: "processing",
    updatedAt: Date.now(),
  };

  saveDedupeStore(store);

  processingEvents.add(eventKey);

  return true;
}

function completeButtonEvent(eventKey, noteId) {
  const store = cleanupDedupeStore(readDedupeStore());

  store[eventKey] = {
    status: "done",
    noteId: String(noteId || ""),
    updatedAt: Date.now(),
  };

  saveDedupeStore(store);

  processingEvents.delete(eventKey);
}

function releaseButtonEvent(eventKey) {
  const store = readDedupeStore();

  if (store[eventKey]?.status === "processing") {
    delete store[eventKey];
    saveDedupeStore(store);
  }

  processingEvents.delete(eventKey);
}

// =====================================================
// MSG91 PAYLOAD PARSING
// =====================================================

function getMessageItems(data) {
  let messages = parseJSON(data.messages);

  if (Array.isArray(messages)) {
    return messages;
  }

  if (messages && typeof messages === "object") {
    return [messages];
  }

  const nestedData = parseJSON(data.data);

  if (Array.isArray(nestedData)) {
    return nestedData;
  }

  if (nestedData && typeof nestedData === "object") {
    if (Array.isArray(nestedData.messages)) {
      return nestedData.messages;
    }

    return [nestedData];
  }

  return [data];
}

function extractButtonInfo(data) {
  const items = getMessageItems(data);

  const customerNumber =
    data.customerNumber ||
    data.customer_number ||
    data.from ||
    data.mobile ||
    data.phone ||
    items.find((item) => item.from)?.from ||
    items.find((item) => item.customerNumber)?.customerNumber ||
    "";

  const phone = normalizePhone(customerNumber);

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

  // Correct timestamp extraction from parsed messages array.
  const rawTimestamp =
    data.timestamp ||
    data.ts ||
    data.requestedAt ||
    items.find((item) => item.timestamp)?.timestamp ||
    null;

  for (const item of items) {
    const parsedButton = parseJSON(item.button);

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

    if (!buttonText && item.interactive?.button_reply) {
      buttonText =
        item.interactive.button_reply.title ||
        item.interactive.button_reply.id ||
        "";

      buttonPayload =
        item.interactive.button_reply.id ||
        "";
    }

    if (!buttonText && item.button_reply) {
      buttonText =
        item.button_reply.title ||
        item.button_reply.text ||
        item.button_reply.id ||
        "";

      buttonPayload =
        item.button_reply.id ||
        "";
    }

    if (!buttonText && item.buttonResponse) {
      buttonText =
        item.buttonResponse.text ||
        item.buttonResponse.title ||
        item.buttonResponse ||
        "";
    }

    if (!buttonText && item.button_text) {
      buttonText = item.button_text;
    }

    if (!buttonText && item.buttonText) {
      buttonText = item.buttonText;
    }

    if (!buttonText && typeof item.button === "string") {
      buttonText = item.button;
    }

    if (buttonText) break;
  }

  // Root-level button fallback.
  if (!buttonText) {
    const rootButton = parseJSON(data.button);

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

  return {
    phone,
    templateName: String(templateName || ""),
    templateLanguage: String(templateLanguage || "en"),
    buttonText: String(buttonText || ""),
    buttonPayload: String(buttonPayload || ""),
    rawTimestamp,
    timestamp: normalizeTimestamp(rawTimestamp),
    items,
  };
}

// =====================================================
// MSG91 TEMPLATE FETCH
// =====================================================

async function fetchMSG91Templates() {
  const response = await axios.get(MSG91_TEMPLATE_URL, {
    headers: MSG91_HEADERS,
    params: {
      plugin: "clevertap",
      number: TARGET_NUMBER,
    },
    timeout: 30000,
  });

  const responseData = response.data;

  if (Array.isArray(responseData)) {
    return responseData;
  }

  if (Array.isArray(responseData?.data)) {
    return responseData.data;
  }

  if (Array.isArray(responseData?.data?.data)) {
    return responseData.data.data;
  }

  console.error(
    "Unexpected MSG91 template response:",
    JSON.stringify(responseData).slice(0, 2000)
  );

  return [];
}

async function getMSG91Template(templateName, language) {
  if (!templateName) {
    return null;
  }

  const templates = await fetchMSG91Templates();

  const matchedTemplate = templates.find((template) => {
    const sameName =
      String(template.name || "").toLowerCase() ===
      String(templateName).toLowerCase();

    const templateLanguage =
      String(template.language || "").toLowerCase();

    const sameLanguage =
      !language ||
      !templateLanguage ||
      templateLanguage === String(language).toLowerCase();

    return sameName && sameLanguage;
  });

  if (!matchedTemplate) {
    console.log("MSG91 template not found:", templateName);
    return null;
  }

  const components = matchedTemplate.components || [];

  const bodyComponent = components.find(
    (component) => component.type === "BODY"
  );

  const headerComponent = components.find(
    (component) => component.type === "HEADER"
  );

  const footerComponent = components.find(
    (component) => component.type === "FOOTER"
  );

  const buttonsComponent = components.find(
    (component) => component.type === "BUTTONS"
  );

  // Template example image, not necessarily the actual campaign image.
  const headerImage =
    headerComponent?.example?.header_handle?.[0] || "";

  return {
    name: matchedTemplate.name || templateName,
    language: matchedTemplate.language || language || "",
    category: matchedTemplate.category || "",
    status: matchedTemplate.status || "",
    body: bodyComponent?.text || "",
    headerFormat: headerComponent?.format || "",
    headerImage,
    footer: footerComponent?.text || "",
    buttons: buttonsComponent?.buttons || [],
  };
}

// =====================================================
// HUBSPOT CONTACT SEARCH
// =====================================================

async function searchHubSpotContact(phone) {
  const phoneVariants = getPhoneVariants(phone);

  if (!phoneVariants.length) {
    return null;
  }

  const filters = phoneVariants.map((number) => ({
    propertyName: "phone",
    operator: "EQ",
    value: number,
  }));

  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/search`,
    {
      filterGroups: filters.map((filter) => ({
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
    },
    {
      headers: HUBSPOT_HEADERS,
      timeout: 30000,
    }
  );

  return response.data.results?.[0] || null;
}

// =====================================================
// HUBSPOT CONTACT CREATE / UPDATE
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

async function updateExistingContact(contactId, templateName) {
  const properties = {
    date_whatsapp: getHubSpotDateValue(),
    wa_creative: templateName || "",
  };

  const response = await axios.patch(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/${contactId}`,
    { properties },
    {
      headers: HUBSPOT_HEADERS,
      timeout: 30000,
    }
  );

  return response.data;
}

// FIXED: Phone number is now sent in +91XXXXXXXXXX format.
async function createNewContact(phone, templateName) {
  const normalizedPhone = normalizePhone(phone);
  const hubspotPhone = formatHubSpotPhone(phone);

  const properties = {
    firstname: normalizedPhone,
    phone: hubspotPhone,
    email: `${normalizedPhone}@noemail.com`,
    wa_creative: templateName || "",
    date_whatsapp: getHubSpotDateValue(),
    profession_category: getProfession(templateName),
    custom_offline_sources_trail: getOfflineSource(templateName),
  };

  console.log("Creating HubSpot contact with phone:", hubspotPhone);

  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts`,
    { properties },
    {
      headers: HUBSPOT_HEADERS,
      timeout: 30000,
    }
  );

  return response.data;
}

async function findOrCreateContact(phone, templateName) {
  const existingContact = await searchHubSpotContact(phone);

  if (existingContact) {
    console.log(
      "Existing HubSpot contact found:",
      existingContact.id
    );

    await updateExistingContact(
      existingContact.id,
      templateName
    );

    return existingContact.id;
  }

  console.log("Creating new HubSpot contact:", phone);

  const newContact = await createNewContact(
    phone,
    templateName
  );

  return newContact.id;
}

// =====================================================
// HUBSPOT NOTE HTML
// =====================================================

function buildNoteHTML(buttonInfo, template) {
  const sections = [];

  sections.push(`
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#333;">
      <h3 style="margin:0 0 12px 0;">
        WhatsApp Button Response
      </h3>
  `);

  sections.push(`
    <p>
      <strong>Customer Number:</strong>
      ${escapeHTML(buttonInfo.phone)}
    </p>
  `);

  sections.push(`
    <p>
      <strong>Template Name:</strong>
      ${escapeHTML(buttonInfo.templateName)}
    </p>
  `);

  sections.push(`
    <p>
      <strong>Button Clicked:</strong>
      ${escapeHTML(buttonInfo.buttonText)}
    </p>
  `);

  if (buttonInfo.buttonPayload) {
    sections.push(`
      <p>
        <strong>Button Payload:</strong>
        ${escapeHTML(buttonInfo.buttonPayload)}
      </p>
    `);
  }

  sections.push(`
    <p>
      <strong>Template Language:</strong>
      ${escapeHTML(template?.language || buttonInfo.templateLanguage)}
    </p>
  `);

  if (template?.category) {
    sections.push(`
      <p>
        <strong>Template Category:</strong>
        ${escapeHTML(template.category)}
      </p>
    `);
  }

  sections.push(`
    <hr style="border:0;border-top:1px solid #ddd;margin:15px 0;">
    <h4 style="margin:0 0 8px 0;">WhatsApp Template Message</h4>
  `);

  if (template?.body) {
    sections.push(`
      <div style="white-space:pre-wrap;margin-bottom:12px;">
        ${escapeHTML(template.body)}
      </div>
    `);
  } else {
    sections.push(`
      <p>Template BODY could not be fetched from MSG91.</p>
    `);
  }

  if (template?.headerImage) {
    const imageURL = safeURL(template.headerImage);

    if (imageURL) {
      sections.push(`
        <h4 style="margin:12px 0 8px 0;">Header Image</h4>

        <img
          src="${escapeHTML(imageURL)}"
          width="250"
          style="
            width:250px;
            max-width:100%;
            height:auto;
            display:block;
            border:0;
            border-radius:6px;
          "
        >
      `);
    }
  }

  if (template?.footer) {
    sections.push(`
      <p style="margin-top:12px;">
        <strong>Footer:</strong>
        ${escapeHTML(template.footer)}
      </p>
    `);
  }

  if (template?.buttons?.length) {
    sections.push(`
      <h4 style="margin:12px 0 8px 0;">Template Buttons</h4>
      <ul style="padding-left:20px;">
    `);

    for (const button of template.buttons) {
      sections.push(`
        <li style="margin-bottom:5px;">
          ${escapeHTML(button.text || button.type || "Button")}
        </li>
      `);
    }

    sections.push("</ul>");
  }

  sections.push(`
      <hr style="border:0;border-top:1px solid #ddd;margin:15px 0;">
      <p style="font-size:11px;color:#777;">
        WhatsApp response received at:
        ${escapeHTML(buttonInfo.timestamp)}
      </p>
    </div>
  `);

  return sections.join("");
}

// =====================================================
// CREATE HUBSPOT NOTE AND ASSOCIATE CONTACT
// =====================================================

async function createHubSpotNote(contactId, buttonInfo, template) {
  const noteBody = buildNoteHTML(buttonInfo, template);

  const payload = {
    properties: {
      hs_note_body: noteBody,
      hs_timestamp: new Date(buttonInfo.timestamp).getTime(),
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

  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/notes`,
    payload,
    {
      headers: HUBSPOT_HEADERS,
      timeout: 30000,
    }
  );

  return response.data;
}

// =====================================================
// MAIN WEBHOOK
// =====================================================

app.post("/webhook/msg91", async (req, res) => {
  let eventKey = null;
  let eventReserved = false;

  try {
    const data = req.body || {};

    console.log(
      "MSG91 Webhook Received:",
      JSON.stringify(data).slice(0, 5000)
    );

    const buttonInfo = extractButtonInfo(data);

    // -------------------------------------------------
    // PHONE CHECK
    // -------------------------------------------------

    if (!buttonInfo.phone) {
      console.log("Phone number missing.");

      return res.status(200).json({
        success: true,
        message: "Phone number missing. Webhook received.",
      });
    }

    // -------------------------------------------------
    // TARGET INTEGRATED NUMBER CHECK
    // -------------------------------------------------

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
      console.log(
        "Webhook received for another integrated number:",
        receivedTarget
      );

      return res.status(200).json({
        success: true,
        message: "Different integrated number. Skipped.",
      });
    }

    // -------------------------------------------------
    // CONTACT CREATE / UPDATE
    // -------------------------------------------------

    const contactId = await findOrCreateContact(
      buttonInfo.phone,
      buttonInfo.templateName
    );

    console.log("HubSpot Contact ID:", contactId);

    // -------------------------------------------------
    // BUTTON RESPONSE CHECK
    // -------------------------------------------------

    if (!buttonInfo.buttonText) {
      console.log(
        "No button response found. Contact logic completed."
      );

      return res.status(200).json({
        success: true,
        message: "Contact processed. No button response.",
        contactId,
      });
    }

    // -------------------------------------------------
    // DUPLICATE BUTTON EVENT CHECK
    // -------------------------------------------------

    eventKey = createButtonEventKey(data, buttonInfo);

    eventReserved = reserveButtonEvent(eventKey);

    if (!eventReserved) {
      console.log("Duplicate or currently processing button event.");

      return res.status(200).json({
        success: true,
        message: "Duplicate Event - Note Skipped",
        contactId,
      });
    }

    // -------------------------------------------------
    // FETCH TEMPLATE FROM MSG91
    // -------------------------------------------------

    let template = null;

    try {
      template = await getMSG91Template(
        buttonInfo.templateName,
        buttonInfo.templateLanguage
      );
    } catch (error) {
      console.error(
        "MSG91 template fetch failed:",
        error.response?.data || error.message
      );
    }

    // -------------------------------------------------
    // CREATE HUBSPOT NOTE
    // -------------------------------------------------

    const note = await createHubSpotNote(
      contactId,
      buttonInfo,
      template
    );

    console.log("HubSpot Note Created:", note.id);

    // -------------------------------------------------
    // MARK EVENT COMPLETED
    // -------------------------------------------------

    completeButtonEvent(eventKey, note.id);

    return res.status(200).json({
      success: true,
      message: "WhatsApp button response processed successfully.",
      contactId,
      noteId: note.id,
      templateName: buttonInfo.templateName,
      buttonText: buttonInfo.buttonText,
    });

  } catch (error) {
    console.error(
      "Webhook Processing Error:",
      error.response?.data || error.message
    );

    if (eventKey && eventReserved) {
      try {
        releaseButtonEvent(eventKey);
      } catch (dedupeError) {
        console.error(
          "Dedupe release error:",
          dedupeError.message
        );
      }
    }

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed.",
      error: error.response?.data || error.message,
    });
  }
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {
  res.status(200).send("MSG91 WhatsApp Webhook Server Running");
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: /webhook/msg91`);

  if (!HUBSPOT_TOKEN) {
    console.error("WARNING: HUBSPOT_TOKEN missing in .env");
  }

  if (!MSG91_AUTHKEY) {
    console.error("WARNING: MSG91_AUTHKEY missing in .env");
  }
});
