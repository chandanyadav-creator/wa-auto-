
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "2mb" }));

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_TOKEN;

// Apna MSG91 integrated number yahan set karein.
// Render Environment Variable INTEGRATED_NUMBER bhi use kar sakte hain.
const INTEGRATED_NUMBER =
  process.env.INTEGRATED_NUMBER || "917088000907";

const HUBSPOT_BASE = "https://api.hubapi.com";

const LOG_PREFIX = "[MSG91-HUBSPOT]";

const PROCESSED_FILE = path.join(process.cwd(), "processed-events.json");

const processedEvents = new Set();
const phoneLocks = new Map();

if (!HUBSPOT_TOKEN) {
  console.error(`${LOG_PREFIX} ERROR: HUBSPOT_ACCESS_TOKEN missing`);
}

// =====================================================
// LOGGING
// =====================================================

function logInfo(message, data = {}) {
  console.log(
    `${new Date().toISOString()} ${LOG_PREFIX} INFO: ${message}`,
    data
  );
}

function logWarn(message, data = {}) {
  console.warn(
    `${new Date().toISOString()} ${LOG_PREFIX} WARN: ${message}`,
    data
  );
}

function logError(message, error, extra = {}) {
  console.error(`${new Date().toISOString()} ${LOG_PREFIX} ERROR: ${message}`);

  if (error?.response) {
    console.error("HTTP STATUS:", error.response.status);
    console.error("API RESPONSE:", JSON.stringify(error.response.data, null, 2));
  } else {
    console.error("ERROR MESSAGE:", error?.message || error);
  }

  if (Object.keys(extra).length) {
    console.error("ADDITIONAL DATA:", extra);
  }
}

function maskPhone(phone = "") {
  const value = String(phone).replace(/\D/g, "");
  if (value.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// =====================================================
// LOAD / SAVE EVENT DEDUPLICATION
// =====================================================

function loadProcessedEvents() {
  try {
    if (!fs.existsSync(PROCESSED_FILE)) {
      fs.writeFileSync(PROCESSED_FILE, "[]");
      logInfo("Created processed-events.json");
      return;
    }

    const saved = JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));

    if (Array.isArray(saved)) {
      saved.forEach((id) => processedEvents.add(String(id)));
    }

    logInfo("Previously processed event IDs loaded", {
      count: processedEvents.size
    });
  } catch (error) {
    logError("Could not load processed events", error);
  }
}

function saveProcessedEvent(eventId) {
  if (!eventId) return;

  processedEvents.add(String(eventId));

  try {
    fs.writeFileSync(
      PROCESSED_FILE,
      JSON.stringify([...processedEvents]),
      "utf8"
    );

    logInfo("Event marked as processed", { eventId });
  } catch (error) {
    logError("Could not save processed event", error, { eventId });
  }
}

loadProcessedEvents();

// =====================================================
// GENERIC PAYLOAD HELPERS
// =====================================================

function findDeepValue(obj, possibleKeys) {
  if (!obj || typeof obj !== "object") return undefined;

  const wanted = possibleKeys.map((key) => key.toLowerCase());

  for (const [key, value] of Object.entries(obj)) {
    if (wanted.includes(key.toLowerCase()) && value !== undefined && value !== null) {
      if (typeof value !== "object") return value;
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = findDeepValue(value, possibleKeys);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function findAllDeepValues(obj, possibleKeys, output = []) {
  if (!obj || typeof obj !== "object") return output;

  const wanted = possibleKeys.map((key) => key.toLowerCase());

  for (const [key, value] of Object.entries(obj)) {
    if (wanted.includes(key.toLowerCase()) && value !== undefined && value !== null) {
      if (typeof value !== "object") output.push(String(value));
    }

    if (value && typeof value === "object") {
      findAllDeepValues(value, possibleKeys, output);
    }
  }

  return [...new Set(output)];
}

// =====================================================
// PHONE NUMBER NORMALIZATION
// =====================================================

function normalizePhone(phone) {
  if (!phone) return "";

  let number = String(phone).replace(/\D/g, "");

  // India country code cleanup
  if (number.startsWith("0091")) {
    number = number.slice(4);
  } else if (number.startsWith("91") && number.length === 12) {
    number = number.slice(2);
  } else if (number.startsWith("0") && number.length === 11) {
    number = number.slice(1);
  }

  return number;
}

function getPhoneSearchVariants(phone) {
  const local = normalizePhone(phone);

  if (!local) return [];

  const variants = new Set([
    local,
    `91${local}`,
    `+91${local}`,
    `0${local}`,
    `0091${local}`,
    `+91 ${local}`,
    `91 ${local}`,
    `${local.slice(0, 5)} ${local.slice(5)}`
  ]);

  return [...variants].filter(Boolean);
}

// =====================================================
// PHONE LOCK - PREVENT SAME-PROCESS SIMULTANEOUS CREATES
// =====================================================

async function withPhoneLock(phone, callback) {
  const key = normalizePhone(phone);

  const previous = phoneLocks.get(key) || Promise.resolve();

  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  phoneLocks.set(key, current);

  logInfo("Waiting for phone processing lock", {
    phone: maskPhone(key)
  });

  await previous;

  logInfo("Phone processing lock acquired", {
    phone: maskPhone(key)
  });

  try {
    return await callback();
  } finally {
    release();

    if (phoneLocks.get(key) === current) {
      phoneLocks.delete(key);
    }

    logInfo("Phone processing lock released", {
      phone: maskPhone(key)
    });
  }
}

// =====================================================
// HUBSPOT API HELPER
// =====================================================

async function hubspotRequest(method, endpoint, data = undefined) {
  const url = `${HUBSPOT_BASE}${endpoint}`;

  logInfo("HubSpot API request started", {
    method,
    endpoint
  });

  try {
    const response = await axios({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 20000
    });

    logInfo("HubSpot API request successful", {
      method,
      endpoint,
      status: response.status
    });

    return response.data;
  } catch (error) {
    logError("HubSpot API request failed", error, {
      method,
      endpoint
    });

    throw error;
  }
}

// =====================================================
// HUBSPOT CONTACT SEARCH
// Searches BOTH phone and mobilephone
// =====================================================

async function findHubSpotContact(phone) {
  const variants = getPhoneSearchVariants(phone);

  logInfo("Starting HubSpot contact search", {
    originalPhone: maskPhone(phone),
    normalizedPhone: maskPhone(normalizePhone(phone)),
    totalVariants: variants.length,
    searchProperties: ["phone", "mobilephone"]
  });

  logInfo("Phone search variants generated", {
    variants: variants.map(maskPhone)
  });

  if (!variants.length) {
    logWarn("No valid phone search variants generated");
    return null;
  }

  const properties = [
    "firstname",
    "lastname",
    "phone",
    "mobilephone",
    "email",
    "date_whatsapp",
    "wa_creative",
    "profession_category"
  ];

  // HubSpot allows a maximum of 5 filter groups per search request.
  const filters = [];

  for (const property of ["phone", "mobilephone"]) {
    for (const value of variants) {
      filters.push({
        propertyName: property,
        operator: "EQ",
        value
      });
    }
  }

  const chunks = [];

  for (let i = 0; i < filters.length; i += 5) {
    chunks.push(filters.slice(i, i + 5));
  }

  logInfo("HubSpot search plan prepared", {
    totalFilters: filters.length,
    totalRequests: chunks.length,
    filtersPerRequest: 5
  });

  const foundContacts = new Map();

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];

    const filterGroups = chunk.map((filter) => ({
      filters: [filter]
    }));

    logInfo(`HubSpot search batch ${index + 1}/${chunks.length}`, {
      filters: chunk.map((filter) => ({
        property: filter.propertyName,
        value: maskPhone(filter.value)
      }))
    });

    const response = await hubspotRequest(
      "POST",
      "/crm/v3/objects/contacts/search",
      {
        filterGroups,
        properties,
        limit: 100
      }
    );

    const results = response.results || [];

    logInfo(`HubSpot search batch ${index + 1} completed`, {
      resultCount: results.length,
      totalAvailable: response.total || 0
    });

    for (const contact of results) {
      foundContacts.set(String(contact.id), contact);
    }
  }

  const contacts = [...foundContacts.values()];

  logInfo("HubSpot contact search completed", {
    uniqueMatches: contacts.length,
    contactIds: contacts.map((contact) => contact.id)
  });

  if (!contacts.length) {
    logInfo("No existing HubSpot contact found");
    return null;
  }

  if (contacts.length > 1) {
    logWarn("Multiple matching HubSpot contacts found. Using first match; no merge performed.", {
      matchingContactIds: contacts.map((contact) => contact.id)
    });
  }

  const selected = contacts[0];

  logInfo("Existing HubSpot contact selected", {
    contactId: selected.id,
    phone: maskPhone(selected.properties?.phone || ""),
    mobilephone: maskPhone(selected.properties?.mobilephone || "")
  });

  return selected;
}

// =====================================================
// HUBSPOT CONTACT CREATE / UPDATE
// =====================================================

function getCurrentDateIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function buildContactProperties(data) {
  const phone = normalizePhone(data.phone);
  const fullPhone = `91${phone}`;

  const properties = {
    firstname: data.name || "WhatsApp Lead",
    phone: fullPhone,
    mobilephone: fullPhone,
    email: `${phone}@noemail.com`,
    date_whatsapp: getCurrentDateIndia(),
    profession_category: "Doctor"
  };

  if (data.templateName) {
    properties.wa_creative = data.templateName;
  } else {
    properties.wa_creative = "Cold_data";
  }

  return properties;
}

async function createHubSpotContact(data) {
  const properties = buildContactProperties(data);

  logInfo("Creating new HubSpot contact", {
    phone: maskPhone(data.phone),
    properties: {
      ...properties,
      phone: maskPhone(properties.phone),
      mobilephone: maskPhone(properties.mobilephone),
      email: "REDACTED"
    }
  });

  const result = await hubspotRequest(
    "POST",
    "/crm/v3/objects/contacts",
    { properties }
  );

  logInfo("New HubSpot contact created", {
    contactId: result.id
  });

  return result;
}

async function updateHubSpotContact(contact, data) {
  const properties = buildContactProperties(data);

  // Do not overwrite the existing firstname with a generic fallback.
  if (!data.name) {
    delete properties.firstname;
  }

  logInfo("Updating existing HubSpot contact", {
    contactId: contact.id,
    phone: maskPhone(data.phone),
    properties: {
      ...properties,
      phone: properties.phone ? maskPhone(properties.phone) : undefined,
      mobilephone: properties.mobilephone
        ? maskPhone(properties.mobilephone)
        : undefined,
      email: properties.email ? "REDACTED" : undefined
    }
  });

  const result = await hubspotRequest(
    "PATCH",
    `/crm/v3/objects/contacts/${contact.id}`,
    { properties }
  );

  logInfo("Existing HubSpot contact updated", {
    contactId: result.id
  });

  return result;
}

// =====================================================
// HUBSPOT TIMELINE NOTE
// =====================================================

async function createWhatsAppNote(contactId, data) {
  if (!data.message) {
    logWarn("Timeline note skipped because message text is empty", {
      contactId
    });
    return null;
  }

  const timestamp = new Date().toISOString();

  const noteBody = [
    "WhatsApp Conversation",
    "",
    `Date: ${timestamp}`,
    `Phone: ${maskPhone(data.phone)}`,
    `Direction: ${data.direction || "INBOUND"}`,
    data.templateName ? `Template: ${data.templateName}` : "",
    "",
    "Message:",
    data.message
  ]
    .filter(Boolean)
    .join("\n");

  logInfo("Creating HubSpot WhatsApp timeline note", {
    contactId,
    messageLength: data.message.length
  });

  const result = await hubspotRequest(
    "POST",
    "/crm/v3/objects/notes",
    {
      properties: {
        hs_timestamp: String(Date.now()),
        hs_note_body: noteBody
      },
      associations: [
        {
          to: {
            id: String(contactId)
          },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 202
            }
          ]
        }
      ]
    }
  );

  logInfo("WhatsApp timeline note created", {
    noteId: result.id,
    contactId
  });

  return result;
}

// =====================================================
// MSG91 WEBHOOK PARSER
// =====================================================

function parseWebhookData(body) {
  const phone =
    findDeepValue(body, [
      "customerNumber",
      "customer_number",
      "mobile",
      "mobileNumber",
      "mobile_number",
      "phone",
      "phoneNumber",
      "phone_number",
      "from",
      "sender"
    ]) || "";

  const name =
    findDeepValue(body, [
      "customerName",
      "customer_name",
      "name",
      "firstname",
      "first_name"
    ]) || "";

  const messageFields = findAllDeepValues(body, [
    "body",
    "text",
    "message",
    "messageText",
    "message_text",
    "buttonText",
    "button_text",
    "title",
    "payload"
  ]);

  const message = messageFields
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => value.length > 0)
    .join(" ")
    .trim();

  const templateName =
    findDeepValue(body, [
      "templateName",
      "template_name",
      "templatename"
    ]) || "";

  const direction =
    findDeepValue(body, [
      "direction",
      "messageDirection",
      "message_direction",
      "type"
    ]) || "";

  const eventId =
    findDeepValue(body, [
      "eventId",
      "event_id",
      "messageId",
      "message_id",
      "wamid",
      "id"
    ]) || "";

  const integratedNumber =
    findDeepValue(body, [
      "integratedNumber",
      "integrated_number",
      "businessNumber",
      "business_number"
    ]) || "";

  const buttonValues = findAllDeepValues(body, [
    "buttonText",
    "button_text",
    "buttonPayload",
    "button_payload",
    "buttonReply",
    "button_reply"
  ]);

  return {
    phone: String(phone),
    name: String(name),
    message,
    templateName: String(templateName),
    direction: String(direction).toLowerCase(),
    eventId: String(eventId),
    integratedNumber: String(integratedNumber),
    buttonValues
  };
}

// =====================================================
// INBOUND / OUTBOUND VALIDATION
// =====================================================

function isOutgoing(data) {
  const direction = String(data.direction || "").toLowerCase();

  const outgoingValues = [
    "outgoing",
    "outbound",
    "sent",
    "send",
    "1"
  ];

  return outgoingValues.includes(direction);
}

function isIncoming(data) {
  const direction = String(data.direction || "").toLowerCase();

  const incomingValues = [
    "incoming",
    "inbound",
    "received",
    "receive",
    "0"
  ];

  return incomingValues.includes(direction);
}

// =====================================================
// STOP DETECTION
// =====================================================

function isStopMessage(data) {
  const stopCandidates = [
    data.message,
    ...(data.buttonValues || [])
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  logInfo("Checking STOP response", {
    textToCheck: stopCandidates.slice(0, 300)
  });

  // Matches STOP, Stop, stop, "Please STOP", etc.
  // Does not match words such as "stopped" or "desktop".
  const matched = /(^|\b)stop(\b|$)/i.test(stopCandidates);

  if (matched) {
    logWarn("STOP response detected. Contact processing will be skipped.", {
      phone: maskPhone(data.phone),
      matchedText: stopCandidates.slice(0, 300)
    });
  } else {
    logInfo("STOP response not detected");
  }

  return matched;
}

// =====================================================
// MAIN WEBHOOK PROCESSOR
// =====================================================

async function processWebhook(body) {
  logInfo("========== WEBHOOK PROCESSING STARTED ==========");

  const data = parseWebhookData(body);

  logInfo("Parsed webhook data", {
    phone: maskPhone(data.phone),
    name: data.name,
    message: data.message.slice(0, 500),
    templateName: data.templateName,
    direction: data.direction,
    eventId: data.eventId,
    integratedNumber: maskPhone(data.integratedNumber)
  });

  // 1. Validate phone
  if (!data.phone) {
    logWarn("Webhook ignored: phone number missing");
    return { ignored: true, reason: "Phone missing" };
  }

  // 2. Ignore outgoing / automatic replies
  if (isOutgoing(data)) {
    logInfo("Outgoing message ignored", {
      phone: maskPhone(data.phone),
      direction: data.direction
    });

    return { ignored: true, reason: "Outgoing message" };
  }

  // If direction is explicitly present but not inbound, ignore it.
  if (data.direction && !isIncoming(data)) {
    logWarn("Unknown message direction. Ignoring to prevent auto-reply processing.", {
      direction: data.direction,
      phone: maskPhone(data.phone)
    });

    return { ignored: true, reason: "Unknown direction" };
  }

  // 3. STOP check before HubSpot search or contact creation
  if (isStopMessage(data)) {
    return { ignored: true, reason: "STOP response" };
  }

  // 4. Message validation
  if (!data.message) {
    logWarn("Webhook ignored: message text missing");
    return { ignored: true, reason: "Message missing" };
  }

  // 5. Integrated number validation, if MSG91 sends it
  if (
    data.integratedNumber &&
    normalizePhone(data.integratedNumber) !== normalizePhone(INTEGRATED_NUMBER)
  ) {
    logWarn("Webhook ignored: integrated number does not match", {
      received: maskPhone(data.integratedNumber),
      configured: maskPhone(INTEGRATED_NUMBER)
    });

    return { ignored: true, reason: "Integrated number mismatch" };
  }

  // 6. Event deduplication
  if (data.eventId && processedEvents.has(data.eventId)) {
    logWarn("Duplicate webhook event ignored", {
      eventId: data.eventId,
      phone: maskPhone(data.phone)
    });

    return { ignored: true, reason: "Duplicate event" };
  }

  // 7. Process same phone sequentially
  return await withPhoneLock(data.phone, async () => {
    logInfo("Starting contact lookup and processing", {
      phone: maskPhone(data.phone)
    });

    // Search existing contact. Search failures throw and stop processing.
    let contact = await findHubSpotContact(data.phone);

    if (contact) {
      logInfo("Existing contact found. Updating contact.", {
        contactId: contact.id
      });

      contact = await updateHubSpotContact(contact, data);
    } else {
      logInfo("No contact found. Creating new contact.");

      try {
        contact = await createHubSpotContact(data);
      } catch (createError) {
        // Re-check after create failure, in case another request created it.
        logWarn("Contact creation failed. Running a second search before exiting.");

        const existingAfterFailure = await findHubSpotContact(data.phone);

        if (existingAfterFailure) {
          logWarn("Contact appeared during retry search. Updating that contact.", {
            contactId: existingAfterFailure.id
          });

          contact = await updateHubSpotContact(existingAfterFailure, data);
        } else {
          throw createError;
        }
      }
    }

    if (!contact?.id) {
      throw new Error("HubSpot contact ID missing after create/update");
    }

    // 8. Create timeline note
    await createWhatsAppNote(contact.id, data);

    // 9. Mark event processed only after successful processing
    if (data.eventId) {
      saveProcessedEvent(data.eventId);
    }

    logInfo("========== WEBHOOK PROCESSING COMPLETED ==========", {
      contactId: contact.id,
      phone: maskPhone(data.phone)
    });

    return {
      success: true,
      contactId: contact.id
    };
  });
}

// =====================================================
// ROUTES
// =====================================================

app.get("/", (req, res) => {
  res.status(200).send("MSG91 - HubSpot webhook server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "MSG91-HubSpot",
    time: new Date().toISOString()
  });
});

app.post("/webhook/msg91", async (req, res) => {
  const startedAt = Date.now();

  logInfo("========== NEW MSG91 WEBHOOK RECEIVED ==========");
  logInfo("Request details", {
    method: req.method,
    path: req.path,
    contentType: req.headers["content-type"],
    userAgent: req.headers["user-agent"],
    receivedAt: new Date().toISOString()
  });

  // Log payload for debugging. Do not log authorization headers.
  logInfo("Incoming webhook payload", {
    body: safeJson(req.body).slice(0, 12000)
  });

  try {
    const result = await processWebhook(req.body || {});

    logInfo("Webhook response sent", {
      status: 200,
      durationMs: Date.now() - startedAt,
      result
    });

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    logError("Webhook processing failed", error, {
      durationMs: Date.now() - startedAt
    });

    return res.status(500).json({
      success: false,
      error: "Webhook processing failed"
    });
  }
});

// =====================================================
// GLOBAL ERROR HANDLERS
// =====================================================

app.use((err, req, res, next) => {
  logError("Express middleware error", err, {
    path: req.path
  });

  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", error);
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {
  console.log("");
  console.log("=================================================");
  console.log(" MSG91 - HUBSPOT WEBHOOK SERVER STARTED");
  console.log("=================================================");

  logInfo("Server configuration", {
    port: PORT,
    integratedNumber: maskPhone(INTEGRATED_NUMBER),
    hubspotTokenConfigured: Boolean(HUBSPOT_TOKEN),
    eventDeduplication: "Enabled",
    phoneLock: "Enabled (single server process)",
    phoneSearchProperties: ["phone", "mobilephone"],
    stopDetection: "Enabled",
    timelineNotes: "Enabled"
  });

  console.log("=================================================");
  console.log("");
});
