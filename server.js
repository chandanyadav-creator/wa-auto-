require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// 🧠 Normalize text
function normalize(text) {
    return (text || "").toLowerCase().trim();
}

// 🎯 Smart message filter
function isValidLead(message) {
    const msg = normalize(message);

    const keywords = [
        "hello sunfox",
        "know more",
        "interested",
        "details"
    ];

    return keywords.some(keyword => msg.includes(keyword));
}

// 🔍 Find contact by phone
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

        return res.data.results[0];
    } catch (err) {
        console.error("❌ Search Error:", err.response?.data || err.message);
        return null;
    }
}

// ➕ Create contact
async function createContact(properties) {
    await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        { properties },
        {
            headers: {
                Authorization: `Bearer ${HUBSPOT_TOKEN}`,
                'Content-Type': 'application/json'
            }
        }
    );
}

// 🔄 Update contact
async function updateContact(id, properties) {
    await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${id}`,
        { properties },
        {
            headers: {
                Authorization: `Bearer ${HUBSPOT_TOKEN}`,
                'Content-Type': 'application/json'
            }
        }
    );
}

// 🏥 Health check
app.get('/', (req, res) => {
    res.send("✅ Server is running");
});

// 🌐 MSG91 Webhook
app.post('/webhook/msg91', async (req, res) => {
    try {
        const data = req.body;

        const name = data.name || "Unknown";
        const phone = data.mobile || data.phone;
        const email = data.email || `${phone}@noemail.com`;
        const message = data.messages || data.message || "";

        console.log("📩 Incoming Lead:", { name, phone, message });

        // ❌ Ignore non-leads
        if (!isValidLead(message)) {
            console.log("⛔ Ignored (not a valid lead)");
            return res.status(200).send("Ignored");
        }

        const properties = {
            firstname: name,
            email: email,
            phone: phone,
            wa_creative: "WhatsApp Ads"
        };

        // 🔁 Check existing contact
        const existing = await findContact(phone);

        if (existing) {
            await updateContact(existing.id, properties);
            console.log("🔄 Contact Updated");
        } else {
            await createContact(properties);
            console.log("✅ Contact Created");
        }

        res.status(200).send("Processed");

    } catch (error) {
        console.error("❌ Webhook Error:", error.response?.data || error.message);
        res.status(500).send("Error");
    }
});

// 🚀 Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
