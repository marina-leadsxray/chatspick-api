import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_PAT;
const TABLE = "Subscriptions";

// 🔍 CHECK CREDIT (used before search)
app.post("/check-credit", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ allowed: false });

    const r = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE}?filterByFormula={email}='${email}'`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
      }
    );

    const data = await r.json();
    if (!data.records.length) return res.json({ allowed: false });

    const rec = data.records[0];
    const pulls = rec.fields.pulls_remaining || 0;

    if (pulls <= 0) return res.json({ allowed: false });

    res.json({ allowed: true });

  } catch (e) {
    console.log(e);
    res.json({ allowed: false });
  }
});

// ⬇️ DEDUCT CREDIT AFTER SEARCH
app.post("/use-credit", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ success: false });

    const r = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE}?filterByFormula={email}='${email}'`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
      }
    );

    const data = await r.json();
    if (!data.records.length) return res.json({ success: false });

    const rec = data.records[0];
    const id = rec.id;
    const pulls = (rec.fields.pulls_remaining || 0) - 1;

    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE}/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: { pulls_remaining: pulls } })
    });

    res.json({ success: true });

  } catch (e) {
    console.log(e);
    res.json({ success: false });
  }
});

app.listen(10000, () => console.log("Credit Gate running on port 10000"));
