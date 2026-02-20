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
      return res.status(500).json({ error: "Airtable query failed", detail: data.error });
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

// ===============================================
// NEW — Check all sold slots for a ZIP area
// ===============================================
app.get("/api/check-zip", async (req, res) => {
  try {
    const { zip, country } = req.query;

    if (!zip) {
      return res.status(400).json({ error: "zip is required" });
    }

    const filterParts = [
      `{ZIP / FSA} = '${zip}'`,
      `OR({Status} = 'Active', {Status} = 'Pending Payment')`
    ];

    if (country) {
      filterParts.push(`{Country} = '${country}'`);
    }

    const formula = `AND(${filterParts.join(",")})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${encodeURIComponent(formula)}&fields%5B%5D=Category&fields%5B%5D=Business+Name&fields%5B%5D=Expiry&fields%5B%5D=Status`;

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const data = await response.json();

    if (data.error) {
      console.error("Airtable error:", data.error);
      return res.status(500).json({ error: "Airtable query failed", detail: data.error });
    }

    const sold = {};
    if (data.records) {
      data.records.forEach(r => {
        if (r.fields["Category"]) {
          sold[r.fields["Category"]] = {
            business_name: r.fields["Business Name"] || "",
            expiry: r.fields["Expiry"] || null,
            status: r.fields["Status"] || ""
          };
        }
      });
    }

    res.json({ zip, country: country || "US", sold });

  } catch (err) {
    console.error("Check-zip error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================================
// NEW — Onboard a business (creates Airtable row)
// ===============================================
app.post("/api/onboard", async (req, res) => {
  try {
    const { business_name, category, zip, country, city, phone, site_url, email, agent, onboarded_via, commission_rate, subscription_tier, annual_price, reveal_text, notes } = req.body;

    if (!business_name || !category || !zip) {
      return res.status(400).json({ error: "business_name, category, and zip are required" });
    }

    const fields = {
      "Business Name": business_name,
      "Category": category,
      "ZIP / FSA": zip,
      "Country": country || "US",
      "Status": "Pending Payment"
    };

    if (city) fields["City"] = city;
    if (phone) fields["Phone Number"] = phone;
    if (site_url) fields["Site URL"] = site_url;
    if (email) fields["Email Address"] = email;
    if (agent) fields["Agent"] = agent;
    if (onboarded_via) fields["Onboarded Via"] = onboarded_via;
    if (commission_rate) fields["Commission Rate"] = commission_rate;
    if (subscription_tier) fields["Subscription Tier"] = subscription_tier;
    if (annual_price) fields["Annual Price"] = annual_price;
    if (reveal_text) fields["Reveal Text"] = reveal_text;
    if (notes) fields["Notes & Comments"] = notes;

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields })
    });

    const data = await response.json();

    if (data.error) {
      console.error("Airtable onboard error:", data.error);
      return res.status(500).json({ error: "Airtable write failed", detail: data.error });
    }

    res.json({ success: true, record_id: data.id, business_name, category, zip });

  } catch (err) {
    console.error("Onboard error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================================
// NEW — Get active pick for reveal page
// ===============================================
app.get("/api/get-pick", async (req, res) => {
  try {
    const { category, zip, country } = req.query;

    if (!category || !zip) {
      return res.status(400).json({ error: "category and zip are required" });
    }

    const filterParts = [
      `{Category} = '${category}'`,
      `{ZIP / FSA} = '${zip}'`,
      `{Status} = 'Active'`
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
      console.error("Airtable get-pick error:", data.error);
      return res.status(500).json({ error: "Airtable query failed" });
    }

    if (data.records && data.records.length > 0) {
      const f = data.records[0].fields;
      res.json({
        found: true,
        business_name: f["Business Name"] || "",
        category: f["Category"] || "",
        city: f["City"] || "",
        phone: f["Phone Number"] || "",
        site_url: f["Site URL"] || "",
        email: f["Email Address"] || "",
        reveal_text: f["Reveal Text"] || "",
        zip: f["ZIP / FSA"] || ""
      });
    } else {
      res.json({ found: false });
    }

  } catch (err) {
    console.error("Get-pick error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================================
// NEW — Reveal page (served from Render)
// Badge clicks here. Consumer matches land here.
// Non-payment = Status not Active = page dies.
// ===============================================
app.get("/reveal/:category/:zip", async (req, res) => {
  try {
    const category = decodeURIComponent(req.params.category).replace(/-/g, " / ").replace(/_/g, " ");
    const zip = req.params.zip;

    // Capitalize words properly
    const catDisplay = category.replace(/\b\w/g, c => c.toUpperCase());

    const filterParts = [
      `{Category} = '${catDisplay}'`,
      `{ZIP / FSA} = '${zip}'`,
      `{Status} = 'Active'`
    ];

    const formula = `AND(${filterParts.join(",")})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const data = await response.json();

    if (data.error || !data.records || data.records.length === 0) {
      return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Chat's Pick</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;color:#333;"><h1 style="font-size:36px;font-weight:900;">Chat's Pick</h1><p style="font-size:18px;color:#999;margin-top:12px;">This pick is not currently available.</p><a href="https://chatspick.com" style="display:inline-block;margin-top:24px;color:#1a1a1a;font-weight:700;text-decoration:none;">← Back to Chat's Pick</a></body></html>`);
    }

    const f = data.records[0].fields;
    const bizName = f["Business Name"] || "";
    const cat = f["Category"] || catDisplay;
    const city = f["City"] || "";
    const phone = f["Phone Number"] || "";
    const siteUrl = f["Site URL"] || "";
    const revealText = f["Reveal Text"] || "";
    const badgeSlug = cat.toLowerCase().replace(/ \/ /g, "-").replace(/ /g, "-");

    // Build bullet points from reveal text
    const bullets = revealText ? revealText.split("\n").filter(l => l.trim()).map(l => `<li style="margin:8px 0;font-size:16px;line-height:1.5;">${l.trim()}</li>`).join("") : "";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Chat's Pick — Best ${cat}${city ? " in " + city : ""}</title>
<meta name="robots" content="noindex, nofollow">
<style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#111;-webkit-font-smoothing:antialiased;}
.container{max-width:540px;margin:0 auto;padding:40px 20px;text-align:center;}
.badge-img{width:200px;margin:0 auto 24px;display:block;}
.biz-name{font-size:32px;font-weight:900;margin:0;}
.biz-cat{font-size:17px;color:#666;font-weight:600;margin:6px 0 0;}
.biz-city{font-size:15px;color:#999;margin:4px 0 24px;}
.bullets{text-align:left;max-width:400px;margin:0 auto 24px;padding:0 0 0 20px;}
.cta-phone{display:inline-block;background:#1a1a1a;color:#fff;font-size:18px;font-weight:700;padding:14px 36px;border-radius:30px;text-decoration:none;margin:8px 0;}
.cta-phone:hover{background:#333;}
.cta-site{display:inline-block;font-size:15px;color:#1a1a1a;font-weight:600;text-decoration:none;margin:12px 0;}
.cta-site:hover{text-decoration:underline;}
.mention{font-size:14px;color:#999;margin-top:24px;font-style:italic;}
.footer{font-size:11px;color:#ccc;margin-top:40px;}
.footer a{color:#ccc;text-decoration:none;}
</style>
</head>
<body>
<div class="container">
  <img class="badge-img" src="https://chatspick.com/badges/${badgeSlug}.png" alt="Chat's Pick — ${cat}" onerror="this.style.display='none'">
  <h1 class="biz-name">${bizName}</h1>
  <div class="biz-cat">Chat's Pick — ${cat}</div>
  <div class="biz-city">${city}${city && zip ? " · " : ""}${zip}</div>
  ${bullets ? '<ul class="bullets">' + bullets + '</ul>' : ''}
  ${phone ? '<a class="cta-phone" href="tel:' + phone.replace(/[^0-9+]/g, '') + '">Call ' + phone + '</a><br>' : ''}
  ${siteUrl ? '<a class="cta-site" href="' + (siteUrl.startsWith("http") ? siteUrl : "https://" + siteUrl) + '" target="_blank">Visit Website →</a>' : ''}
  <p class="mention">Mention Chat's Pick for priority service</p>
  <div class="footer">
    <a href="https://chatspick.com">Chat's Pick</a> — AI Decision Engine
  </div>
</div>
</body>
</html>`;

    res.send(html);

  } catch (err) {
    console.error("Reveal page error:", err);
    res.status(500).send("Server error");
  }
});

// ===============================================
// NEW — Badge image proxy (kill switch on non-payment)
// ===============================================
app.get("/api/badge/:slug", async (req, res) => {
  try {
    const slug = req.params.slug.replace(".png", "");
    const { zip } = req.query;

    if (!zip) {
      // No ZIP = just serve the badge (for generic use)
      return res.redirect(`https://chatspick.com/badges/${slug}.png`);
    }

    // Check if slot is active
    const cat = slug.replace(/-/g, " / ").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const formula = `AND({Category} = '${cat}', {ZIP / FSA} = '${zip}', {Status} = 'Active')`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&fields%5B%5D=Status`;

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const data = await response.json();

    if (data.records && data.records.length > 0) {
      return res.redirect(`https://chatspick.com/badges/${slug}.png`);
    } else {
      // Not active — return transparent 1x1 pixel (badge disappears)
      const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "no-cache, no-store");
      return res.send(pixel);
    }

  } catch (err) {
    console.error("Badge proxy error:", err);
    res.status(500).send("");
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Proxy running on port " + PORT));
