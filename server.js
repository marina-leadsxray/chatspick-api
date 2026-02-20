const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();
app.use(cors());
app.use(express.json());

// ===============================================
// EXISTING — Claude chat proxy (DO NOT TOUCH)
// ===============================================
app.post("/chat", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: req.body.model || "claude-sonnet-4-20250514",
        max_tokens: req.body.max_tokens || 75,
        system: req.body.system || "",
        messages: req.body.messages || []
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Failed to reach Claude API" });
  }
});

// ===============================================
// NEW — Slot availability checker
// ===============================================
const AIRTABLE_BASE = "appq0MbQye4KejWD1";
const AIRTABLE_TABLE = "tblhdtAFhsYMhcukS";

app.get("/api/check-slot", async (req, res) => {
  try {
    const { category, zip, country } = req.query;

    if (!category || !zip) {
      return res.status(400).json({ error: "category and zip are required" });
    }

    const filterParts = [
      `{Category} = '${category}'`,
      `{ZIP / FSA} = '${zip}'`,
      `OR({Status} = 'Active', {Status} = 'Pending Payment')`
    ];

    if (country) {
      filterParts.push(`{Country} = '${country}'`);
    }

    const formula = `AND(${filterParts.join(",")})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const data = await response.json();

    if (data.error) {
      console.error("Airtable error:", data.error);
      return res.status(500).json({ error: "Airtable query failed" });
    }

    if (data.records && data.records.length > 0) {
      const fields = data.records[0].fields;
      res.json({
        available: false,
        business_name: fields["Business Name"] || "",
        status: fields["Status"] || "",
        expiry: fields["Expiry"] || null
      });
    } else {
      res.json({ available: true });
    }

  } catch (err) {
    console.error("Check-slot error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Proxy running on port " + PORT));
