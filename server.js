
require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

const MSG91_AUTHKEY = process.env.MSG91_AUTHKEY;
const MSG91_TEMPLATE_URL = process.env.MSG91_TEMPLATE_URL;
const MSG91_TEMPLATE_METHOD = (
    process.env.MSG91_TEMPLATE_METHOD || "GET"
).toUpperCase();

const TARGET_NUMBER = "917088000907";
const HUBSPOT_BASE_URL = "https://api.hubapi.com";

const hubspot = axios.create({
    baseURL: HUBSPOT_BASE_URL,
    timeout: 20000,
    headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
    }
});

// =====================================================
// LOGGING
// =====================================================

function log(title, data = null) {
    console.log(
        `\n[${new Date().toISOString()}] ${title}`
    );

    if (data !== null) {
        try {
            console.log(JSON.stringify(data, null, 2));
        } catch {
            console.log(data);
        }
    }
}

function logError(title, error) {
    console.error(`\n❌ ${title}`);

    console.error(
        "Status:",
        error.response?.status || "N/A"
    );

    console.error(
        "Response:",
        JSON.stringify(
            error.response?.data || error.message,
            null,
            2
        )
    );
}

function maskPhone(phone = "") {
    const clean = String(phone).replace(/\D/g, "");
    return clean.length > 4
        ? "******" + clean.slice(-4)
        : "****";
}

// =====================================================
// INDIA DATE
// =====================================================

function getCurrentDateIndia() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}

// =====================================================
// PHONE FORMATTING
// =====================================================

function formatPhone(phone) {
    if (!phone) return "";

    const clean = String(phone).replace(/\D/g, "");

    if (!clean) return "";

    if (clean.length === 10) {
        return `+91${clean}`;
    }

    if (clean.length === 12 && clean.startsWith("91")) {
        return `+${clean}`;
    }

    if (clean.length === 11 && clean.startsWith("0")) {
        return `+91${clean.substring(1)}`;
    }

    if (String(phone).trim().startsWith("+")) {
        return `+${clean}`;
    }

    return `+${clean}`;
}

function generatePhoneVariants(phone) {
    const clean = String(phone || "").replace(/\D/g, "");

    let local = clean;

    if (clean.startsWith("0091")) {
        local = clean.substring(4);
    } else if (clean.startsWith("91") && clean.length === 12) {
        local = clean.substring(2);
    } else if (clean.startsWith("0") && clean.length === 11) {
        local = clean.substring(1);
    }

    if (!local) return [];

    return [...new Set([
        local,
        `91${local}`,
        `+91${local}`,
        `0${local}`,
        `0091${local}`,
        `+91 ${local}`,
        `91 ${local}`
    ])];
}

// =====================================================
// GENERIC PAYLOAD HELPERS
// =====================================================

function findDeepValue(obj, keys) {
    if (!obj || typeof obj !== "object") return undefined;

    const wanted = keys.map(k => k.toLowerCase());

    for (const [key, value] of Object.entries(obj)) {
        if (
            wanted.includes(key.toLowerCase()) &&
            value !== undefined &&
            value !== null &&
            typeof value !== "object"
        ) {
            return value;
        }
    }

    for (const value of Object.values(obj)) {
        if (value && typeof value === "object") {
            const found = findDeepValue(value, keys);
            if (found !== undefined) return found;
        }
    }

    return undefined;
}

function findAllDeepValues(obj, keys, output = []) {
    if (!obj || typeof obj !== "object") return output;

    const wanted = keys.map(k => k.toLowerCase());

    for (const [key, value] of Object.entries(obj)) {
        if (
            wanted.includes(key.toLowerCase()) &&
            value !== undefined &&
            value !== null &&
            typeof value !== "object"
        ) {
            output.push(String(value));
        }

        if (value && typeof value === "object") {
            findAllDeepValues(value, keys, output);
        }
    }

    return [...new Set(output)];
}

// =====================================================
// EXTRACT CUSTOMER NUMBER
// =====================================================

function extractCustomerNumber(data) {
    const directNumber =
        data?.customerNumber ||
        data?.customer_number ||
        data?.mobile ||
        data?.phone;

    if (directNumber) {
        return String(directNumber).trim();
    }

    let messages = data?.messages;

    try {
        if (typeof messages === "string") {
            messages = JSON.parse(messages);
        }

        if (Array.isArray(messages)) {
            for (const item of messages) {
                if (item?.from) {
                    return String(item.from).trim();
                }
            }
        }
    } catch (error) {
        log("Phone extraction from messages failed", error.message);
    }

    return "";
}

// =====================================================
// EXTRACT WHATSAPP MESSAGE
// =====================================================

function extractMessage(messageData) {
    if (!messageData) return "";

    if (typeof messageData === "string") {
        try {
            const parsed = JSON.parse(messageData);
            return extractMessage(parsed);
        } catch {
            return messageData.trim();
        }
    }

    if (Array.isArray(messageData)) {
        return messageData
            .map(item => extractMessage(item))
            .filter(Boolean)
            .join("\n");
    }

    if (typeof messageData === "object") {
        return (
            messageData?.text?.body ||
            messageData?.text ||
            messageData?.body ||
            messageData?.message ||
            messageData?.button?.text ||
            messageData?.button?.payload ||
            messageData?.interactive?.button_reply?.title ||
            messageData?.interactive?.button_reply?.id ||
            messageData?.interactive?.list_reply?.title ||
            messageData?.interactive?.list_reply?.id ||
            ""
        );
    }

    return "";
}

// =====================================================
// PARSE WEBHOOK
// =====================================================

function parseWebhook(data) {
    const rawPhone = extractCustomerNumber(data);

    const phone = formatPhone(rawPhone);

    const name = String(
        data?.customerName ||
        data?.customer_name ||
        data?.name ||
        "Unknown"
    ).trim();

    const integratedNumber = String(
        data?.integratedNumber ||
        data?.integrated_number ||
        ""
    ).trim();

    const templateName = String(
        data?.templateName ||
        data?.template_name ||
        ""
    ).trim();

    let rawMessage =
        data?.messages ||
        data?.text ||
        data?.message ||
        "";

    const message = String(extractMessage(rawMessage) || "").trim();

    const direction = String(
        findDeepValue(data, [
            "direction",
            "messageDirection",
            "message_direction"
        ]) || ""
    ).toLowerCase();

    const messageId = String(
        findDeepValue(data, [
            "uuid",
            "messageId",
            "message_id",
            "eventId",
            "event_id"
        ]) || ""
    );

    const buttonValues = findAllDeepValues(data, [
        "buttonText",
        "button_text",
        "buttonPayload",
        "button_payload",
        "buttonReply",
        "button_reply"
    ]);

    return {
        rawPhone,
        phone,
        name,
        integratedNumber,
        templateName,
        message,
        direction,
        messageId,
        buttonValues
    };
}

// =====================================================
// STOP FILTER
// =====================================================

function isStopMessage(data) {
    const values = [
        data.message,
        ...(data.buttonValues || [])
    ].filter(Boolean);

    const text = values.join(" ").trim();

    log("STOP FILTER CHECK", {
        phone: maskPhone(data.phone),
        text: text.slice(0, 300)
    });

    const matched = /(^|\b)stop(\b|$)/i.test(text);

    if (matched) {
        log("⛔ STOP DETECTED - WEBHOOK IGNORED", {
            phone: maskPhone(data.phone)
        });
    }

    return matched;
}

// =====================================================
// MSG91 TEMPLATE FETCH
// =====================================================

function extractTemplateList(responseData) {
    const possible = [
        responseData?.data?.templates,
        responseData?.templates,
        responseData?.data,
        responseData?.results
    ];

    for (const item of possible) {
        if (Array.isArray(item)) return item;
    }

    // API may return one template object directly.
    if (
        responseData?.data?.components ||
        responseData?.components
    ) {
        return [
            responseData.data?.components
                ? responseData.data
                : responseData
        ];
    }

    return [];
}

async function fetchMSG91Template(templateName) {
    log("========== MSG91 TEMPLATE FETCH STARTED ==========");

    if (!MSG91_AUTHKEY || !MSG91_TEMPLATE_URL) {
        throw new Error(
            "MSG91_AUTHKEY or MSG91_TEMPLATE_URL is missing in Render"
        );
    }

    log("Template fetch request", {
        templateName,
        integratedNumber: TARGET_NUMBER,
        method: MSG91_TEMPLATE_METHOD,
        endpoint: MSG91_TEMPLATE_URL
    });

    try {
        const config = {
            method: MSG91_TEMPLATE_METHOD,
            url: MSG91_TEMPLATE_URL,
            headers: {
                authkey: MSG91_AUTHKEY,
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            timeout: 20000
        };

        if (MSG91_TEMPLATE_METHOD === "GET") {
            config.params = {
                integrated_number: TARGET_NUMBER
            };
        } else {
            config.data = {
                integrated_number: TARGET_NUMBER
            };
        }

        const response = await axios(config);

        log("MSG91 template API response status", response.status);

        const templates = extractTemplateList(response.data);

        log("Templates returned by MSG91", {
            count: templates.length
        });

        const matched = templates.find(item => {
            const currentName =
                item?.name ||
                item?.template_name ||
                item?.templateName;

            return String(currentName || "").toLowerCase() ===
                templateName.toLowerCase();
        });

        if (!matched) {
            log("⚠️ Matching template not found in MSG91 response", {
                requestedTemplate: templateName,
                availableTemplates: templates.map(item =>
                    item?.name || item?.template_name || ""
                )
            });

            return {
                name: templateName,
                language: "",
                category: "",
                status: "",
                body: "",
                header: null,
                buttons: [],
                raw: null,
                fetchStatus: "NOT_FOUND"
            };
        }

        const components = matched.components || [];

        const bodyComponent = components.find(
            item => item.type === "BODY"
        );

        const headerComponent = components.find(
            item => item.type === "HEADER"
        );

        const footerComponent = components.find(
            item => item.type === "FOOTER"
        );

        const buttonComponent = components.find(
            item => item.type === "BUTTONS"
        );

        const details = {
            name: matched.name || templateName,
            language: matched.language || matched.language_code || "",
            category: matched.category || "",
            status: matched.status || "",
            body: bodyComponent?.text || "",
            header: headerComponent || null,
            footer: footerComponent?.text || "",
            buttons: buttonComponent?.buttons || [],
            raw: matched,
            fetchStatus: "FOUND"
        };

        log("✅ MSG91 TEMPLATE MATCHED", {
            name: details.name,
            language: details.language,
            category: details.category,
            status: details.status,
            body: details.body,
            header: details.header,
            footer: details.footer,
            buttons: details.buttons
        });

        return details;

    } catch (error) {
        logError("MSG91 TEMPLATE FETCH FAILED", error);
        throw error;
    }
}

// =====================================================
// HUBSPOT CONTACT SEARCH
// =====================================================

async function findContact(phone) {
    const variants = generatePhoneVariants(phone);

    log("========== HUBSPOT CONTACT SEARCH ==========", {
        phone: maskPhone(phone),
        variants: variants.map(maskPhone)
    });

    if (!variants.length) {
        throw new Error("No valid phone variants");
    }

    const found = new Map();

    for (const propertyName of ["phone", "mobilephone"]) {
        for (const variant of variants) {
            log("Searching HubSpot", {
                property: propertyName,
                value: maskPhone(variant)
            });

            try {
                const response = await hubspot.post(
                    "/crm/v3/objects/contacts/search",
                    {
                        filterGroups: [
                            {
                                filters: [
                                    {
                                        propertyName,
                                        operator: "EQ",
                                        value: variant
                                    }
                                ]
                            }
                        ],
                        properties: [
                            "firstname",
                            "lastname",
                            "phone",
                            "mobilephone",
                            "email",
                            "date_whatsapp",
                            "wa_creative"
                        ],
                        limit: 100
                    }
                );

                const results = response.data?.results || [];

                log("HubSpot search result", {
                    property: propertyName,
                    variant: maskPhone(variant),
                    resultCount: results.length
                });

                results.forEach(contact => {
                    found.set(String(contact.id), contact);
                });

            } catch (error) {
                logError(
                    `HubSpot search failed: ${propertyName}`,
                    error
                );

                // Stop processing if search fails.
                // Never create a new contact after a failed search.
                throw error;
            }
        }
    }

    const contacts = [...found.values()];

    log("HubSpot contact search completed", {
        matchingContacts: contacts.length,
        contactIds: contacts.map(item => item.id)
    });

    if (contacts.length > 1) {
        log("⚠️ Multiple matching contacts found. No merge performed.");
    }

    return contacts[0] || null;
}

// =====================================================
// HUBSPOT CREATE CONTACT
// =====================================================

async function createContact(properties) {
    log("========== CREATING NEW HUBSPOT CONTACT ==========");
    log("New contact properties", {
        ...properties,
        email: "REDACTED"
    });

    const response = await hubspot.post(
        "/crm/v3/objects/contacts",
        { properties }
    );

    log("✅ HUBSPOT CONTACT CREATED", {
        contactId: response.data.id
    });

    return response.data;
}

// =====================================================
// HUBSPOT UPDATE CONTACT
// =====================================================

async function updateContact(contactId, properties) {
    log("========== UPDATING EXISTING HUBSPOT CONTACT ==========");

    log("Update properties", {
        contactId,
        properties
    });

    const response = await hubspot.patch(
        `/crm/v3/objects/contacts/${contactId}`,
        { properties }
    );

    log("✅ EXISTING CONTACT UPDATED", {
        contactId: response.data.id
    });

    return response.data;
}

// =====================================================
// HUBSPOT TIMELINE NOTE
// =====================================================

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

async function createWhatsAppNote(contactId, data) {
    log("========== HUBSPOT TIMELINE NOTE STARTED ==========");

    log("Note details", {
        contactId,
        phone: maskPhone(data.phone),
        templateName: data.templateName,
        messageLength: data.message.length,
        templateFetchStatus: data.template?.fetchStatus
    });

    const template = data.template || {};

    const buttonHtml = (template.buttons || [])
        .map(button => `
            <li>
                ${escapeHtml(button.text || button.title || "")}
                ${button.url
                    ? ` - ${escapeHtml(button.url)}`
                    : ""}
            </li>
        `)
        .join("");

    const headerText = template.header
        ? (
            template.header.text ||
            template.header.format ||
            "Header available"
        )
        : "No header";

    const noteBody = `
        <h3>WhatsApp Conversation</h3>

        <p><b>Customer:</b> ${escapeHtml(data.name)}</p>
        <p><b>Phone:</b> ${escapeHtml(data.phone)}</p>
        <p><b>Direction:</b> Incoming</p>
        <p><b>Message:</b> ${escapeHtml(data.message)}</p>

        <hr>

        <h3>MSG91 Template Details</h3>

        <p><b>Template Name:</b> ${escapeHtml(data.templateName)}</p>
        <p><b>Language:</b> ${escapeHtml(template.language)}</p>
        <p><b>Category:</b> ${escapeHtml(template.category)}</p>
        <p><b>Status:</b> ${escapeHtml(template.status)}</p>
        <p><b>Fetch Status:</b> ${escapeHtml(template.fetchStatus)}</p>

        <p><b>Template Header:</b> ${escapeHtml(headerText)}</p>

        <p><b>Template Body:</b></p>
        <p>${escapeHtml(template.body || "Not available")}</p>

        <p><b>Template Footer:</b>
        ${escapeHtml(template.footer || "Not available")}</p>

        ${buttonHtml
            ? `<p><b>Template Buttons:</b></p><ul>${buttonHtml}</ul>`
            : "<p>No template buttons</p>"}

        <hr>

        <p><b>MSG91 Message ID:</b>
        ${escapeHtml(data.messageId || "N/A")}</p>

        <p><b>Received At:</b>
        ${new Date().toISOString()}</p>

        <p><b>Source:</b> MSG91 WhatsApp</p>
    `;

    try {
        const response = await hubspot.post(
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

        log("✅ HUBSPOT TIMELINE NOTE CREATED", {
            noteId: response.data.id,
            contactId
        });

        return response.data;

    } catch (error) {
        logError("HUBSPOT TIMELINE NOTE FAILED", error);
        throw error;
    }
}

// =====================================================
// PHONE LOCK
// =====================================================

const phoneLocks = new Map();

async function withPhoneLock(phone, callback) {
    const key = String(phone).replace(/\D/g, "");

    const previous = phoneLocks.get(key) || Promise.resolve();

    let release;

    const current = new Promise(resolve => {
        release = resolve;
    });

    phoneLocks.set(key, current);

    await previous;

    log("Phone lock acquired", maskPhone(key));

    try {
        return await callback();
    } finally {
        release();

        if (phoneLocks.get(key) === current) {
            phoneLocks.delete(key);
        }

        log("Phone lock released", maskPhone(key));
    }
}

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {
    res.status(200).send(
        "MSG91 → HubSpot Webhook Running"
    );
});

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        time: new Date().toISOString()
    });
});

// =====================================================
// MAIN MSG91 WEBHOOK
// =====================================================

app.post("/webhook/msg91", async (req, res) => {
    const startTime = Date.now();

    log("========== NEW MSG91 WEBHOOK RECEIVED ==========");

    try {
        const rawData = req.body || {};

        log("RAW MSG91 WEBHOOK", rawData);

        // ---------------------------------------------
        // PARSE DATA
        // ---------------------------------------------

        const data = parseWebhook(rawData);

        log("PARSED WEBHOOK DATA", {
            name: data.name,
            rawPhone: maskPhone(data.rawPhone),
            phone: maskPhone(data.phone),
            integratedNumber: maskPhone(data.integratedNumber),
            templateName: data.templateName,
            message: data.message,
            direction: data.direction,
            messageId: data.messageId,
            buttonValues: data.buttonValues
        });

        // ---------------------------------------------
        // FILTER 1: INTEGRATED NUMBER
        // ---------------------------------------------

        const incomingIntegratedNumber =
            data.integratedNumber.replace(/\D/g, "");

        if (incomingIntegratedNumber !== TARGET_NUMBER) {
            log("⛔ IGNORED: WRONG INTEGRATED NUMBER");

            return res.status(200).send(
                "Ignored - Wrong Integrated Number"
            );
        }

        // ---------------------------------------------
        // FILTER 2: STOP
        // ---------------------------------------------

        if (isStopMessage(data)) {
            return res.status(200).send(
                "Ignored - STOP Response"
            );
        }

        // ---------------------------------------------
        // FILTER 3: OUTGOING MESSAGE
        // ---------------------------------------------

        const outgoingDirections = [
            "outgoing",
            "outbound",
            "sent",
            "send"
        ];

        if (outgoingDirections.includes(data.direction)) {
            log("⛔ IGNORED: OUTGOING / AUTO REPLY");

            return res.status(200).send(
                "Ignored - Outgoing Message"
            );
        }

        // ---------------------------------------------
        // FILTER 4: TEMPLATE NAME
        // ---------------------------------------------

        if (!data.templateName) {
            log("⛔ IGNORED: TEMPLATE NAME MISSING");

            return res.status(200).send(
                "Ignored - Template Name Missing"
            );
        }

        // ---------------------------------------------
        // FILTER 5: CUSTOMER PHONE
        // ---------------------------------------------

        if (!data.phone) {
            log("⛔ IGNORED: CUSTOMER PHONE MISSING");

            return res.status(200).send(
                "Ignored - Phone Missing"
            );
        }

        // ---------------------------------------------
        // FILTER 6: MESSAGE
        // ---------------------------------------------

        if (!data.message) {
            log("⛔ IGNORED: MESSAGE TEXT MISSING");

            return res.status(200).send(
                "Ignored - Message Missing"
            );
        }

        // ---------------------------------------------
        // PROCESS SAME PHONE SEQUENTIALLY
        // ---------------------------------------------

        const result = await withPhoneLock(
            data.phone,
            async () => {

                // -------------------------------------
                // CURRENT INDIA DATE
                // -------------------------------------

                const currentDateIndia = getCurrentDateIndia();

                // -------------------------------------
                // PROFESSION CATEGORY
                // -------------------------------------

                const templateLower =
                    data.templateName.toLowerCase();

                let professionCategory;

                if (templateLower.includes("pharm")) {
                    professionCategory = "Pharmacy";
                } else if (templateLower.includes("diag")) {
                    professionCategory = "Healthcare Professional";
                } else {
                    professionCategory = "Doctor";
                }

                // -------------------------------------
                // OFFLINE SOURCE
                // -------------------------------------

                const offlineSource =
                    templateLower.startsWith("purch")
                        ? "Purchased Data"
                        : "Data Mining";

                log("PROFESSION AND SOURCE IDENTIFIED", {
                    professionCategory,
                    offlineSource
                });

                // -------------------------------------
                // NEW CONTACT PROPERTIES
                // -------------------------------------

                const properties = {
                    firstname: data.name,
                    phone: data.phone,
                    email: `${data.phone.replace(/\D/g, "")}@noemail.com`,
                    wa_creative: data.templateName,
                    date_whatsapp: currentDateIndia,
                    profession_category: professionCategory,
                    custom_offline_sources_trail: offlineSource
                };

                log("HUBSPOT NEW CONTACT PROPERTIES", {
                    ...properties,
                    email: "REDACTED"
                });

                // -------------------------------------
                // SEARCH CONTACT
                // -------------------------------------

                const existingContact =
                    await findContact(data.phone);

                let contactId;
                let contactAction;

                // -------------------------------------
                // EXISTING CONTACT
                // -------------------------------------

                if (existingContact) {
                    contactId = existingContact.id;
                    contactAction = "UPDATED";

                    log("EXISTING CONTACT FOUND", {
                        contactId
                    });

                    log(
                        "Updating only date_whatsapp and wa_creative"
                    );

                    const updated = await updateContact(
                        contactId,
                        {
                            date_whatsapp: currentDateIndia,
                            wa_creative: data.templateName
                        }
                    );

                    if (!updated?.id) {
                        throw new Error(
                            "Existing contact update failed"
                        );
                    }
                }

                // -------------------------------------
                // NEW CONTACT
                // -------------------------------------

                else {
                    log("CONTACT NOT FOUND - CREATING NEW CONTACT");

                    const created =
                        await createContact(properties);

                    if (!created?.id) {
                        throw new Error(
                            "New contact creation failed"
                        );
                    }

                    contactId = created.id;
                    contactAction = "CREATED";
                }

                // -------------------------------------
                // FETCH MSG91 TEMPLATE DETAILS
                // -------------------------------------

                const templateDetails =
                    await fetchMSG91Template(data.templateName);

                // -------------------------------------
                // CREATE NOTE FOR BOTH CONTACT TYPES
                // -------------------------------------

                log(
                    "Creating WhatsApp Timeline Note for contact",
                    {
                        contactId,
                        contactAction
                    }
                );

                const note = await createWhatsAppNote(
                    contactId,
                    {
                        name: data.name,
                        phone: data.phone,
                        message: data.message,
                        messageId: data.messageId,
                        templateName: data.templateName,
                        template: templateDetails
                    }
                );

                return {
                    contactId,
                    contactAction,
                    noteId: note.id,
                    templateName: data.templateName,
                    professionCategory,
                    offlineSource
                };
            }
        );

        // ---------------------------------------------
        // SUCCESS
        // ---------------------------------------------

        log("========== WEBHOOK SUCCESS ==========", {
            ...result,
            durationMs: Date.now() - startTime
        });

        return res.status(200).json({
            success: true,
            ...result
        });

    } catch (error) {
        logError("WEBHOOK PROCESSING FAILED", error);

        return res.status(500).json({
            success: false,
            error: "Webhook processing failed"
        });
    }
});

// =====================================================
// SERVER START
// =====================================================

app.listen(PORT, () => {
    console.log("\n============================================");
    console.log("MSG91 - HUBSPOT WEBHOOK SERVER STARTED");
    console.log("============================================");

    log("SERVER CONFIGURATION", {
        port: PORT,
        targetNumber: TARGET_NUMBER,
        hubspotTokenConfigured: Boolean(HUBSPOT_TOKEN),
        msg91AuthkeyConfigured: Boolean(MSG91_AUTHKEY),
        templateURLConfigured: Boolean(MSG91_TEMPLATE_URL),
        templateMethod: MSG91_TEMPLATE_METHOD,
        webhook: "/webhook/msg91"
    });
});
