
require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// 🎯 Target MSG91 Integrated Number
const TARGET_NUMBER = "917088000907";

const HUBSPOT_BASE_URL = "https://api.hubapi.com";

/* =========================================================
   🔐 HUBSPOT AXIOS INSTANCE
========================================================= */

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

// 🇮🇳 Current date in India
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

    if (!phone) {
        return "";
    }

    const original = String(phone).trim();
    const clean = original.replace(/\D/g, "");

    if (!clean) {
        return "";
    }

    // 10 digit Indian number
    if (clean.length === 10) {
        return `+91${clean}`;
    }

    // 12 digit number starting with 91
    if (
        clean.length === 12 &&
        clean.startsWith("91")
    ) {
        return `+${clean}`;
    }

    // Other formats
    if (original.startsWith("+")) {
        return `+${clean}`;
    }

    return `+${clean}`;
}


// 📞 Generate phone variants for HubSpot search
function generatePhoneVariants(phone) {

    if (!phone) {
        return [];
    }

    const clean = String(phone).replace(/\D/g, "");

    const variants = new Set();

    // 10 digit number
    if (clean.length === 10) {

        variants.add(clean);
        variants.add(`91${clean}`);
        variants.add(`+91${clean}`);

    }

    // 12 digit number starting with 91
    else if (
        clean.length === 12 &&
        clean.startsWith("91")
    ) {

        const number = clean.substring(2);

        variants.add(number);
        variants.add(clean);
        variants.add(`+${clean}`);

    }

    // Fallback
    else {

        variants.add(clean);
        variants.add(`+${clean}`);

    }

    return [...variants];
}


/* =========================================================
   📩 EXTRACT MESSAGE FROM MSG91 PAYLOAD
========================================================= */

function extractMessage(messageData) {

    if (!messageData) {
        return "";
    }

    // If already object
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

    // If JSON string
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


/* =========================================================
   📞 EXTRACT CUSTOMER NUMBER
========================================================= */

function extractCustomerNumber(data) {

    // 1️⃣ Original MSG91 customerNumber
    if (data?.customerNumber) {

        const number =
            String(data.customerNumber).trim();

        if (number) {
            return number;
        }
    }

    // 2️⃣ Fallback: messages[].from
    if (data?.messages) {

        try {

            const parsed =
                typeof data.messages === "string"
                    ? JSON.parse(data.messages)
                    : data.messages;

            if (Array.isArray(parsed)) {

                for (const item of parsed) {

                    if (item?.from) {

                        return String(
                            item.from
                        ).trim();

                    }
                }
            }

        } catch (error) {

            console.error(
                "❌ Error extracting phone from messages:",
                error.message
            );

        }
    }

    return "";
}


/* =========================================================
   📝 LOGGER
========================================================= */

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
   🔍 FIND CONTACT IN HUBSPOT
========================================================= */

async function findContact(phone) {

    const variants =
        generatePhoneVariants(phone);

    if (!variants.length) {

        console.log(
            "❌ No valid phone variants"
        );

        return null;
    }

    console.log(
        "📞 Searching phone variants:",
        variants
    );

    for (const variant of variants) {

        try {

            const response =
                await hubspot.post(
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
                        limit: 1
                    }
                );

            const results =
                response.data?.results || [];

            if (results.length > 0) {

                console.log(
                    `✅ Contact found using phone: ${variant}`
                );

                return results[0];
            }

        } catch (error) {

            console.error(
                `❌ Search error for ${variant}:`,
                error.response?.data ||
                error.message
            );

            // Continue with next variant
        }
    }

    console.log(
        "❌ No existing contact found"
    );

    return null;
}


/* =========================================================
   🆕 CREATE CONTACT
========================================================= */

async function createContact(properties) {

    try {

        const response =
            await hubspot.post(
                "/crm/v3/objects/contacts",
                {
                    properties
                }
            );

        console.log(
            "✅ Contact Created:",
            response.data.id
        );

        return response.data;

    } catch (error) {

        console.error(
            "❌ Contact Create Error:",
            error.response?.data ||
            error.message
        );

        return null;
    }
}


/* =========================================================
   🔄 UPDATE CONTACT
========================================================= */

async function updateContact(
    contactId,
    properties
) {

    try {

        const response =
            await hubspot.patch(
                `/crm/v3/objects/contacts/${contactId}`,
                {
                    properties
                }
            );

        console.log(
            "✅ Contact Updated:",
            contactId
        );

        return response.data;

    } catch (error) {

        console.error(
            "❌ Contact Update Error:",
            error.response?.data ||
            error.message
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

app.post(
    "/webhook/msg91",
    async (req, res) => {

        try {

            const data = req.body || {};


            /* =================================================
               🔴 RAW WEBHOOK
            ================================================= */

            log(
                "📩 RAW MSG91 WEBHOOK",
                data
            );


            /* =================================================
               📊 EXTRACT DATA
            ================================================= */

            const name =
                String(
                    data.customerName ||
                    "Unknown"
                ).trim();


            // customerNumber empty ho to
            // messages[].from se number lega
            const rawPhone =
                extractCustomerNumber(data);


            const phone =
                formatPhone(rawPhone);


            const integratedNumber =
                String(
                    data.integratedNumber ||
                    ""
                ).trim();


            // Template name
            const templateName =
                String(
                    data.templateName ||
                    ""
                ).trim();


            const rawMessage =
                data.messages ||
                data.text ||
                "";


            const message =
                extractMessage(
                    rawMessage
                );


            /* =================================================
               📊 PARSED DATA
            ================================================= */

            log(
                "📊 PARSED WEBHOOK DATA",
                {
                    name,
                    rawPhone,
                    phone,
                    integratedNumber,
                    templateName,
                    message
                }
            );


            /* =================================================
               🎯 FILTER 1
               INTEGRATED NUMBER
            ================================================= */

            if (
                integratedNumber !==
                TARGET_NUMBER
            ) {

                console.log(
                    `⛔ Ignored: Wrong integrated number - ${integratedNumber}`
                );

                return res
                    .status(200)
                    .send(
                        "Ignored - Wrong Integrated Number"
                    );
            }


            /* =================================================
               🎯 FILTER 2
               TEMPLATE NAME
            ================================================= */

            if (!templateName) {

                console.log(
                    "⛔ Ignored: templateName missing or empty"
                );

                return res
                    .status(200)
                    .send(
                        "Ignored - Template Name Missing"
                    );
            }


            /* =================================================
               📞 FILTER 3
               PHONE NUMBER
            ================================================= */

            if (!phone) {

                console.log(
                    "⛔ Ignored: Customer phone missing"
                );

                return res
                    .status(200)
                    .send(
                        "Ignored - Phone Missing"
                    );
            }


            /* =================================================
               📅 CURRENT INDIA DATE
            ================================================= */

            const currentDateIndia =
                getCurrentDateIndia();


            /* =================================================
               🏥 PROFESSION CATEGORY

               If templateName contains "pharm"
               → Pharmacy

               If templateName contains "diag"
               → Healthcare Professional

               Otherwise
               → Doctor
            ================================================= */

            const templateLower =
                templateName.toLowerCase();


            let professionCategory;


            if (
                templateLower.includes("pharm")
            ) {

                professionCategory =
                    "Pharmacy";

            }

            else if (
                templateLower.includes("diag")
            ) {

                professionCategory =
                    "Healthcare Professional";

            }

            else {

                professionCategory =
                    "Doctor";

            }


            /* =================================================
               📦 OFFLINE SOURCE LOGIC

               NEW CONTACT ONLY

               If template name starts with "purch"
               → Purchased Data

               Otherwise
               → Data Mining
            ================================================= */

            const offlineSource =
                templateLower.startsWith("purch")
                    ? "Purchased Data"
                    : "Data Mining";


            console.log(
                `📦 Offline Source: ${offlineSource}`
            );


            /* =================================================
               📦 HUBSPOT PROPERTIES
               FOR NEW CONTACT
            ================================================= */

            const properties = {

                firstname:
                    name,

                phone:
                    phone,

                email:
                    `${phone}@noemail.com`,

                // 🔥 Template name
                // Existing/New contact dono me
                wa_creative:
                    templateName,

                // WhatsApp date
                date_whatsapp:
                    currentDateIndia,

                // Profession
                profession_category:
                    professionCategory,

                // Offline Source
                custom_offline_sources_trail:
                    offlineSource

            };


            log(
                "📦 HUBSPOT PAYLOAD FOR NEW CONTACT",
                properties
            );


            /* =================================================
               🔍 SEARCH EXISTING CONTACT
            ================================================= */

            const existingContact =
                await findContact(phone);


            /* =================================================
               🔄 EXISTING CONTACT

               Existing contact me:

               1. date_whatsapp update
               2. wa_creative update with current
                  templateName

               Baaki properties update nahi hongi.
            ================================================= */

            if (existingContact) {

                console.log(
                    `🔄 Existing contact found: ${existingContact.id}`
                );

                console.log(
                    `📅 Updating date_whatsapp: ${currentDateIndia}`
                );

                console.log(
                    `📝 Updating wa_creative/template: ${templateName}`
                );


                const updated =
                    await updateContact(
                        existingContact.id,
                        {
                            date_whatsapp:
                                currentDateIndia,

                            wa_creative:
                                templateName
                        }
                    );


                if (!updated) {

                    return res
                        .status(500)
                        .send(
                            "HubSpot Update Failed"
                        );
                }


                console.log(
                    "✅ Existing contact updated successfully."
                );

                console.log(
                    "   • date_whatsapp updated"
                );

                console.log(
                    "   • wa_creative/template updated"
                );

            }


            /* =================================================
               🆕 NEW CONTACT

               New contact me saari properties
               create hongi.

               purch* template:
               Purchased Data

               Other template:
               Data Mining
            ================================================= */

            else {

                console.log(
                    "🆕 Contact not found. Creating..."
                );

                console.log(
                    `📦 New Contact Offline Source: ${offlineSource}`
                );


                const created =
                    await createContact(
                        properties
                    );


                if (!created) {

                    return res
                        .status(500)
                        .send(
                            "HubSpot Create Failed"
                        );
                }


                console.log(
                    "✅ New contact created successfully."
                );

            }


            /* =================================================
               ✅ SUCCESS
            ================================================= */

            console.log(
                `✅ Processed Successfully | Template: ${templateName} | Profession: ${professionCategory} | Offline Source: ${offlineSource} | Phone: ${phone} | Date: ${currentDateIndia}`
            );


            return res
                .status(200)
                .send(
                    "Processed"
                );


        } catch (error) {

            console.error(
                "🔥 WEBHOOK ERROR:",
                error.response?.data ||
                error.message
            );


            return res
                .status(500)
                .send(
                    "Internal Server Error"
                );

        }

    }
);


/* =========================================================
   🚀 START SERVER
========================================================= */

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 Server running on port ${PORT}`
        );

        console.log(
            `🎯 Target Integrated Number: ${TARGET_NUMBER}`
        );

        console.log(
            "📩 Webhook: /webhook/msg91"
        );

    }
);
