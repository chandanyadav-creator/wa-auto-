require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// 🎯 Target MSG91 Integrated Number
const TARGET_NUMBER = "917088000907";

// HubSpot API
const HUBSPOT_BASE_URL = "https://api.hubapi.com";

// Axios instance
const hubspot = axios.create({
    baseURL: HUBSPOT_BASE_URL,
    timeout: 15000,
    headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
    }
});

/* =========================================================
   🧠 UTILITY FUNCTIONS
========================================================= */

// 🇮🇳 Current date according to India
function getCurrentDateIndia() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}


// 📞 Format phone number to +91XXXXXXXXXX
function formatPhone(phone) {
    if (!phone) return "";

    const original = String(phone).trim();
    const clean = original.replace(/\D/g, "");

    if (!clean) return "";

    // 10 digit Indian number
    if (clean.length === 10) {
        return `+91${clean}`;
    }

    // 12 digit Indian number starting with 91
    if (clean.length === 12 && clean.startsWith("91")) {
        return `+${clean}`;
    }

    // Already +91
    if (original.startsWith("+")) {
        return `+${clean}`;
    }

    return `+${clean}`;
}


// 📞 Generate phone variants for HubSpot search
function generatePhoneVariants(phone) {
    if (!phone) return [];

    const clean = String(phone).replace(/\D/g, "");

    const variants = new Set();

    // 10 digit
    if (clean.length === 10) {
        variants.add(clean);
        variants.add(`91${clean}`);
        variants.add(`+91${clean}`);
    }

    // 12 digit starting 91
    else if (clean.length === 12 && clean.startsWith("91")) {
        const number = clean.substring(2);

        variants.add(number);
        variants.add(clean);
        variants.add(`+${clean}`);
    }

    // Generic fallback
    else {
        variants.add(clean);
        variants.add(`+${clean}`);
    }

    return [...variants];
}


// 📩 Extract message from MSG91 payload
function extractMessage(messageData) {
    if (!messageData) return "";

    // Already object
    if (typeof messageData === "object") {
        if (Array.isArray(messageData)) {
            return messageData[0]?.text?.body || "";
        }

        return (
            messageData?.text?.body ||
            messageData?.body ||
            ""
        );
    }

    // String JSON
    try {
        const parsed = JSON.parse(messageData);

        if (Array.isArray(parsed)) {
            return parsed[0]?.text?.body || "";
        }

        return (
            parsed?.text?.body ||
            parsed?.body ||
            ""
        );

    } catch {
        return String(messageData);
    }
}


// 📝 Logger
function log(title, data) {
    console.log(`\n🔹 ${title}`);

    try {
        console.log(
            JSON.stringify(data, null, 2)
        );
    } catch {
        console.log(data);
    }
}


/* =========================================================
   🔍 HUBSPOT - FIND CONTACT
========================================================= */

async function findContact(phone) {
    const variants = generatePhoneVariants(phone);

    if (!variants.length) {
        console.log("❌ No valid phone variants");
        return null;
    }

    console.log("📞 Searching HubSpot phone variants:", variants);

    for (const variant of variants) {

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
                                    value: variant
                                }
                            ]
                        }
                    ],
                    properties: [
                        "firstname",
                        "phone",
                        "email",
                        "wa_creative",
                        "date_whatsapp",
                        "profession_category"
                    ],
                    limit: 1
                }
            );

            const results = response.data?.results || [];

            if (results.length > 0) {

                console.log(
                    `✅ Existing contact found using ${variant}`
                );

                return results[0];
            }

        } catch (error) {

            console.error(
                `❌ HubSpot search failed for ${variant}:`,
                error.response?.data || error.message
            );

            // Continue checking next phone variant
        }
    }

    console.log("❌ No existing contact found");

    return null;
}


/* =========================================================
   🆕 HUBSPOT - CREATE CONTACT
========================================================= */

async function createContact(properties) {

    try {

        const response = await hubspot.post(
            "/crm/v3/objects/contacts",
            {
                properties
            }
        );

        console.log(
            "✅ New HubSpot contact created:",
            response.data.id
        );

        return response.data;

    } catch (error) {

        console.error(
            "❌ HubSpot create error:",
            error.response?.data || error.message
        );

        return null;
    }
}


/* =========================================================
   🔄 HUBSPOT - UPDATE CONTACT
========================================================= */

async function updateContact(contactId, properties) {

    try {

        const response = await hubspot.patch(
            `/crm/v3/objects/contacts/${contactId}`,
            {
                properties
            }
        );

        console.log(
            "✅ HubSpot contact updated:",
            contactId
        );

        return response.data;

    } catch (error) {

        console.error(
            "❌ HubSpot update error:",
            error.response?.data || error.message
        );

        return null;
    }
}


/* =========================================================
   🌐 HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {

    res.status(200).send(
        "MSG91 → HubSpot Webhook Running ✅"
    );
});


/* =========================================================
   📩 MSG91 WEBHOOK
========================================================= */

app.post("/webhook/msg91", async (req, res) => {

    try {

        const data = req.body || {};

        // Log raw webhook
        log("📩 RAW MSG91 WEBHOOK", data);


        /* =====================================================
           Extract webhook fields
        ===================================================== */

        const name =
            String(data.customerName || "Unknown").trim();

        const rawPhone =
            data.customerNumber || "";

        const phone =
            formatPhone(rawPhone);

        const integratedNumber =
            String(data.integratedNumber || "").trim();

        const templateName =
            String(data.templateName || "").trim();

        const rawMessage =
            data.messages ||
            data.text ||
            "";

        const message =
            extractMessage(rawMessage);


        /* =====================================================
           Parsed Data
        ===================================================== */

        log("📊 PARSED WEBHOOK DATA", {
            name,
            rawPhone,
            phone,
            integratedNumber,
            templateName,
            message
        });


        /* =====================================================
           🎯 FILTER 1
           Integrated Number
        ===================================================== */

        if (integratedNumber !== TARGET_NUMBER) {

            console.log(
                `⛔ Ignored: Wrong integrated number (${integratedNumber})`
            );

            return res
                .status(200)
                .send("Ignored - Wrong Integrated Number");
        }


        /* =====================================================
           🎯 FILTER 2
           Template Name
           
           IMPORTANT:
           Template name can be ANY value.
           But it MUST exist.
        ===================================================== */

        if (!templateName) {

            console.log(
                "⛔ Ignored: templateName missing or empty"
            );

            return res
                .status(200)
                .send("Ignored - Template Name Missing");
        }


        /* =====================================================
           📞 FILTER 3
           Phone Number
        ===================================================== */

        if (!phone) {

            console.log(
                "⛔ Ignored: Customer phone number missing"
            );

            return res
                .status(200)
                .send("Ignored - Phone Missing");
        }


        /* =====================================================
           📅 Current India Date
        ===================================================== */

        const currentDateIndia =
            getCurrentDateIndia();


        /* =====================================================
           📦 HUBSPOT PROPERTIES
        ===================================================== */

        const properties = {

            firstname: name,

            phone: phone,

            email: `${phone}@noemail.com`,

            wa_creative: "Cold_data",

            date_whatapps: currentDateIndia,

            profession_category: "Doctor"
        };


        log(
            "📦 HUBSPOT PAYLOAD",
            properties
        );


        /* =====================================================
           🔍 SEARCH EXISTING CONTACT
        ===================================================== */

        const existingContact =
            await findContact(phone);


        /* =====================================================
           🔄 EXISTING CONTACT → UPDATE
        ===================================================== */

        if (existingContact) {

            console.log(
                `🔄 Updating existing contact: ${existingContact.id}`
            );

            const updated =
                await updateContact(
                    existingContact.id,
                    properties
                );

            if (!updated) {

                return res
                    .status(500)
                    .send("HubSpot Update Failed");
            }
        }


        /* =====================================================
           🆕 CONTACT NOT FOUND → CREATE
        ===================================================== */

        else {

            console.log(
                "🆕 Contact not found. Creating new contact..."
            );

            const created =
                await createContact(properties);

            if (!created) {

                return res
                    .status(500)
                    .send("HubSpot Create Failed");
            }
        }


        /* =====================================================
           ✅ SUCCESS
        ===================================================== */

        console.log(
            `✅ Processed successfully | Template: ${templateName} | Phone: ${phone}`
        );

        return res
            .status(200)
            .send("Processed");


    } catch (error) {

        console.error(
            "🔥 WEBHOOK ERROR:",
            error.response?.data ||
            error.message
        );

        return res
            .status(500)
            .send("Internal Server Error");
    }
});


/* =========================================================
   🚀 START SERVER
========================================================= */

app.listen(PORT, () => {

    console.log(
        `🚀 Server running on port ${PORT}`
    );

    console.log(
        `🎯 Target Integrated Number: ${TARGET_NUMBER}`
    );

    console.log(
        "📩 MSG91 Webhook: /webhook/msg91"
    );

});
