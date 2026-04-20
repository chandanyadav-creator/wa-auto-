require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// 🎯 Target Integrated Number
const TARGET_NUMBER = "917088000907";

/* ================================
   🧠 Utility Functions
================================ */

// Normalize text
function normalize(text) {
    return (text || "").toLowerCase().trim();
}

// Format phone to +91
function formatPhone(phone) {
    if (!phone) return "";

    const clean = phone.replace(/\D/g, "");

    if (clean.length === 10) return `+91${clean}`;
    if (clean.length === 12 && clean.startsWith("91")) return `+${clean}`;
    if (phone.startsWith("+")) return phone;

    return `+${clean}`;
}

// Generate all phone variants
function generatePhoneVariants(phone) {
    const clean = phone.replace(/\D/g, "");
    const variants = new Set();

    if (clean.length === 10) {
        variants.add(`+91${clean}`);
        variants.add(`91${clean}`);
        variants.add(clean);
    }

    if (clean.length === 12 && clean.startsWith("91")) {
        const num = clean.slice(2);
        variants.add(`+91${num}`);
        variants.add(clean);
        variants.add(num);
    }

    return Array.from(variants);
}

// Extract message from MSG91 JSON
function extractMessage(msg) {
    try {
        const parsed = JSON.parse(msg);
        return parsed[0]?.text?.body || "";
    } catch {
        return msg;
    }
}

// Logger
function log(title, data) {
    console.log(`\n🔹 ${title}`);
    console.log(JSON.stringify(data, null, 2));
}

/* ================================
   🔍 HubSpot Functions
================================ */

// Search contact (multi-format)
async function findContact(phone) {
    try {
        const variants = generatePhoneVariants(phone);

        console.log("📞 Searching variants:", variants);

        for (const variant of variants) {
            const res = await axios.post(
                'https://api.hubapi.com/crm/v3/objects/contacts/search',
                {
                    filterGroups: [{
                        filters: [{
                            propertyName: "phone",
                            operator: "EQ",
                            value: variant
                        }]
                    }]
                },
                {
                    headers: {
                        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (res.data.results.length > 0) {
                console.log("✅ Match found with:", variant);
                return res.data.results[0];
            }
        }

        console.log("❌ No contact found");
        return null;

    } catch (err) {
        console.error("❌ Search Error:", err.response?.data || err.message);
        return null;
    }
}

// Create contact
async function createContact(properties) {
    try {
        const res = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/contacts',
            { properties },
            {
                headers: {
                    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        log("✅ Contact Created", res.data);

    } catch (err) {
        console.error("❌ Create Error:", err.response?.data || err.message);
    }
}

// Update contact
async function updateContact(id, properties) {
    try {
        const res = await axios.patch(
            `https://api.hubapi.com/crm/v3/objects/contacts/${id}`,
            { properties },
            {
                headers: {
                    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        log("🔄 Contact Updated", res.data);

    } catch (err) {
        console.error("❌ Update Error:", err.response?.data || err.message);
    }
}

/* ================================
   🌐 Routes
================================ */

// Health check
app.get('/', (req, res) => {
    console.log("✅ Health check hit");
    res.send("Server Running ✅");
});

// Webhook
app.post('/webhook/msg91', async (req, res) => {
    try {
        log("📩 RAW WEBHOOK BODY", req.body);

        const data = req.body;

        const name = data.customerName || "Unknown";
        const rawPhone = data.customerNumber;
        const phone = formatPhone(rawPhone);

        const rawMessage = data.messages || data.text || "";
        const message = extractMessage(rawMessage);

        const integratedNumber = data.integratedNumber;

        log("📊 Parsed Data", { name, phone, message, integratedNumber });

        // 🎯 FILTER BY INTEGRATED NUMBER ONLY
        if (integratedNumber !== TARGET_NUMBER) {
            console.log("⛔ Ignored: wrong integrated number");
            return res.status(200).send("Ignored");
        }

        const properties = {
            firstname: name,
            phone: phone,
            email: `${phone}@noemail.com`,
            wa_creative: "Whatsapp_Campaign_100426"
        };

        log("📦 HubSpot Payload", properties);

        // Search + deduplicate
        const existing = await findContact(phone);

        if (existing) {
            console.log("🔄 Updating existing contact:", existing.id);
            await updateContact(existing.id, properties);
        } else {
            console.log("🆕 Creating new contact");
            await createContact(properties);
        }

        console.log("✅ Webhook processed successfully\n");

        res.status(200).send("Processed");

    } catch (error) {
        console.error("🔥 Webhook Error:", error.response?.data || error.message);
        res.status(500).send("Error");
    }
});

/* ================================
   🚀 Start Server
================================ */

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
