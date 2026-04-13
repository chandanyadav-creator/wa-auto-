require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// 🧠 Normalize
function normalize(text) {
    return (text || "").toLowerCase().trim();
}

// 🎯 Lead filter
function isValidLead(message) {
    const msg = normalize(message);
    return msg.includes("hello sunfox");
}

// 🪵 Debug Logger
function log(title, data) {
    console.log(`\n🔹 ${title}`);
    console.log(JSON.stringify(data, null, 2));
}

// 🔍 Find contact
async function findContact(phone) {
    try {
        const res = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/contacts/search',
            {
                filterGroups: [{
                    filters: [{
                        propertyName: "phone",
                        operator: "EQ",
                        value: phone
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

        log("HubSpot Search Response", res.data);
        return res.data.results[0];

    } catch (err) {
        console.error("❌ Search Error:", err.response?.data || err.message);
        return null;
    }
}

// ➕ Create
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

// 🔄 Update
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

// 🏥 Health
app.get('/', (req, res) => {
    console.log("✅ Health check hit");
    res.send("Server Running ✅");
});

// 🌐 Webhook
app.post('/webhook/msg91', async (req, res) => {
    try {
        log("📩 RAW WEBHOOK BODY", req.body);

        const data = req.body;

        const name = data.customerName || "Unknown";
        const phone = data.customerNumber;
        const message = data.messages || data.text || "";

        log("📊 Parsed Data", { name, phone, message });

        // ❌ Ignore
        if (!isValidLead(message)) {
            console.log("⛔ Ignored: message not matched");
            return res.status(200).send("Ignored");
        }

        const properties = {
            firstname: name,
            phone: phone,
            email: `${phone}@noemail.com`,
            wa_creative: "WhatsApp Ads"
        };

        log("📦 HubSpot Payload", properties);

        const existing = await findContact(phone);

        if (existing) {
            console.log("🔄 Existing contact found:", existing.id);
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

// 🚀 Start
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
