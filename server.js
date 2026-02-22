const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const app = express();
app.use(cors());
app.use(express.json());

// ===============================================
// STATIC — Serve badge PNGs from /public/badges/
// ===============================================
app.use('/badges', express.static(path.join(__dirname, 'public', 'badges'), {
  maxAge: '7d',
  setHeaders: (res) => { res.set('Cache-Control', 'public, max-age=604800'); }
}));

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
// Slot availability checker
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
// Check all sold slots for a ZIP area
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
// Onboard a business (creates Airtable row)
// ===============================================
app.post("/api/onboard", async (req, res) => {
  try {
    const { business_name, category, zip, country, city, phone, site_url, email, address, rating, reviews, agent, onboarded_via, commission_rate, subscription_tier, annual_price, reveal_text, notes } = req.body;

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
    if (address) fields["Address"] = address;
    if (rating) fields["Rating"] = String(rating);
    if (reviews) fields["Reviews"] = String(reviews);
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
// Get active pick for reveal page (API)
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
        address: f["Address"] || "",
        rating: f["Rating"] || "",
        reviews: f["Reviews"] || "",
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
// SHARED — Reveal page HTML template
// Used by both production and preview routes
// ===============================================
function buildRevealHTML(d) {
  const bizName = d.bizName || "";
  const cat = d.cat || "";
  const city = d.city || "";
  const zip = d.zip || "";
  const phone = d.phone || "";
  const siteUrl = d.siteUrl || "";
  const address = d.address || "";
  const rating = d.rating || "";
  const reviews = d.reviews || "";
  const revealText = d.revealText || "";
  const badgeSlug = cat.toLowerCase().replace(/ \/ /g, "-").replace(/ /g, "-");
  const isPreview = d.isPreview || false;

  // Build bullet points from reveal text (newline separated)
  const bullets = revealText
    ? revealText.split("\n").filter(l => l.trim()).map(l =>
        `<li>${l.trim().replace(/^[-•]\s*/, '')}</li>`
      ).join("")
    : "";

  // Rating stars display
  const ratingNum = parseFloat(rating) || 0;
  const fullStars = Math.floor(ratingNum);
  const halfStar = (ratingNum - fullStars) >= 0.3 ? 1 : 0;
  const emptyStars = 5 - fullStars - halfStar;
  const starsHTML = ratingNum > 0
    ? `<div class="rating">
        ${'<span class="star full">★</span>'.repeat(fullStars)}${halfStar ? '<span class="star half">★</span>' : ''}${'<span class="star empty">☆</span>'.repeat(emptyStars)}
        <span class="rating-text">${rating} stars · ${reviews || '?'} Google reviews</span>
      </div>`
    : "";

  // Google Maps embed
  const mapQuery = encodeURIComponent(bizName + " " + address);
  const mapEmbed = address
    ? `<div class="map-wrap">
        <iframe src="https://www.google.com/maps?q=${mapQuery}&output=embed" allowfullscreen loading="lazy"></iframe>
      </div>`
    : "";

  // NAP block
  const napParts = [];
  if (address) napParts.push(`<div class="nap-line">📍 ${address}</div>`);
  if (phone) napParts.push(`<div class="nap-line">📱 <a href="tel:${phone.replace(/[^0-9+]/g, '')}">${phone}</a></div>`);
  if (siteUrl) {
    const cleanUrl = siteUrl.startsWith("http") ? siteUrl : "https://" + siteUrl;
    const displayUrl = siteUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    napParts.push(`<div class="nap-line">🌐 <a href="${cleanUrl}" target="_blank">${displayUrl}</a></div>`);
  }
  const napHTML = napParts.length ? `<div class="nap">${napParts.join("")}</div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Chat's Pick — ${cat}${city ? " in " + city : ""}</title>
<meta name="robots" content="noindex, nofollow">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',system-ui,-apple-system,sans-serif;background:#fafafa;color:#111;-webkit-font-smoothing:antialiased;}
.container{max-width:580px;margin:0 auto;padding:40px 20px 60px;}
${isPreview ? '.preview-bar{background:#ff9800;color:#fff;text-align:center;padding:10px;font-size:14px;font-weight:700;letter-spacing:0.5px;}' : ''}
.badge-wrap{text-align:center;margin-bottom:28px;}
.badge-img{width:220px;display:inline-block;}
.biz-name{font-size:34px;font-weight:900;text-align:center;color:#0d0d0d;line-height:1.2;}
.biz-cat{font-size:16px;color:#666;font-weight:600;text-align:center;margin:6px 0 0;}
.territory{font-size:14px;color:#888;text-align:center;margin:6px 0 24px;line-height:1.5;}
.rating{text-align:center;margin:16px 0 20px;}
.star{font-size:22px;}
.star.full{color:#f5a623;}
.star.half{color:#f5a623;opacity:0.6;}
.star.empty{color:#ddd;}
.rating-text{font-size:14px;color:#666;margin-left:8px;vertical-align:middle;}
.why-section{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px 24px;margin:24px 0;}
.why-title{font-size:18px;font-weight:800;color:#0d0d0d;margin-bottom:14px;}
.why-list{list-style:none;padding:0;}
.why-list li{font-size:16px;line-height:1.6;color:#333;padding:6px 0 6px 28px;position:relative;}
.why-list li:before{content:"✓";position:absolute;left:0;color:#28a745;font-weight:700;font-size:18px;}
.nap{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:20px 24px;margin:20px 0;}
.nap-line{font-size:15px;color:#333;padding:6px 0;line-height:1.5;}
.nap-line a{color:#1565c0;text-decoration:none;font-weight:600;}
.nap-line a:hover{text-decoration:underline;}
.map-wrap{margin:20px 0;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;}
.map-wrap iframe{width:100%;height:280px;border:0;}
.cta-wrap{text-align:center;margin:28px 0 12px;}
.cta-phone{display:inline-block;background:#0d0d0d;color:#fff;font-size:18px;font-weight:700;padding:16px 44px;border-radius:40px;text-decoration:none;transition:background 0.2s;}
.cta-phone:hover{background:#333;}
.cta-site{display:inline-block;font-size:15px;color:#0d0d0d;font-weight:600;text-decoration:none;margin-top:14px;}
.cta-site:hover{text-decoration:underline;}
.mention{font-size:14px;color:#999;text-align:center;margin-top:28px;font-style:italic;}
.footer{text-align:center;font-size:12px;color:#ccc;margin-top:40px;padding-top:20px;border-top:1px solid #eee;}
.footer a{color:#999;text-decoration:none;font-weight:600;}
</style>
</head>
<body>
${isPreview ? '<div class="preview-bar">⚡ PREVIEW — This is how your Chat\'s Pick will look to customers</div>' : ''}
<div class="container">
  <div class="badge-wrap">
    <img class="badge-img" src="/badges/${badgeSlug}.png" alt="Chat's Pick — ${cat}" onerror="this.style.display='none'">
  </div>
  <h1 class="biz-name">${bizName}</h1>
  <div class="biz-cat">Chat's Pick — ${cat}</div>
  <div class="territory">${city && city.includes(",") ? "Serving " + city + " and surrounding areas" : city || zip}</div>
  ${starsHTML}
  ${bullets ? `
  <div class="why-section">
    <div class="why-title">Why ${bizName} is Chat's Pick</div>
    <ul class="why-list">${bullets}</ul>
  </div>` : ''}
  ${napHTML}
  ${mapEmbed}
  <div class="cta-wrap">
    ${phone ? `<a class="cta-phone" href="tel:${phone.replace(/[^0-9+]/g, '')}">Call ${phone}</a><br>` : ''}
    ${siteUrl ? `<a class="cta-site" href="${siteUrl.startsWith("http") ? siteUrl : "https://" + siteUrl}" target="_blank">Visit Website →</a>` : ''}
  </div>
  <p class="mention">Mention Chat's Pick for priority service</p>
  <div class="footer">
    <a href="https://chatspick.com">Chat's Pick</a> · One provider per category per area
    <br><span style="font-size:10px;color:#ddd;">Chat's Pick is a paid co-promotion.</span>
  </div>
</div>
</body>
</html>`;
}

// ===============================================
// SHARED — Landing page HTML template
// Used by both production and preview routes
// ===============================================
function buildLandingHTML(d) {
  const cat = d.cat || "";
  const city = d.city || "";
  const zip = d.zip || "";
  const isPreview = d.isPreview || false;
  const badgeSlug = cat.toLowerCase().replace(/ \/ /g, "-").replace(/ /g, "-");
  const revealSlug = isPreview
    ? `/preview/reveal/${badgeSlug}/${zip}?${d.queryString || ''}`
    : `/reveal/${badgeSlug}/${zip}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Chat's Pick ${cat} in ${city || "ZIP " + zip}</title>
<meta name="description" content="Looking for the best ${cat.toLowerCase()} in ${city || "your area"}? Chat's Pick recommends one trusted ${cat.toLowerCase()} per area. See who made the cut.">
${isPreview ? '<meta name="robots" content="noindex, nofollow">' : ''}
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',system-ui,-apple-system,sans-serif;background:#fff;color:#111;-webkit-font-smoothing:antialiased;}
${isPreview ? '.preview-bar{background:#ff9800;color:#fff;text-align:center;padding:10px;font-size:14px;font-weight:700;letter-spacing:0.5px;}' : ''}
.hero{max-width:640px;margin:0 auto;padding:80px 20px 60px;text-align:center;}
.badge-img{width:180px;margin-bottom:24px;}
.hero h1{font-size:38px;font-weight:900;line-height:1.2;color:#0d0d0d;}
.hero h1 span{color:#e63946;}
.hero-sub{font-size:18px;color:#555;margin-top:16px;line-height:1.6;max-width:480px;margin-left:auto;margin-right:auto;}
.hero-points{list-style:none;padding:0;margin:32px auto;max-width:400px;text-align:left;}
.hero-points li{font-size:16px;color:#333;padding:8px 0 8px 28px;position:relative;line-height:1.5;}
.hero-points li:before{content:"✓";position:absolute;left:0;color:#28a745;font-weight:700;}
.cta-wrap{margin:36px 0 20px;}
.cta-btn{display:inline-block;background:#0d0d0d;color:#fff;font-size:19px;font-weight:700;padding:18px 48px;border-radius:40px;text-decoration:none;transition:background 0.2s;}
.cta-btn:hover{background:#333;}
.trust{font-size:13px;color:#999;margin-top:16px;}
.footer{text-align:center;font-size:12px;color:#ccc;margin-top:60px;padding:20px;border-top:1px solid #eee;}
.footer a{color:#999;text-decoration:none;font-weight:600;}
</style>
</head>
<body>
${isPreview ? '<div class="preview-bar">⚡ PREVIEW — This is your SEO landing page</div>' : ''}
<div class="hero">
  <img class="badge-img" src="/badges/${badgeSlug}.png" alt="Chat's Pick — ${cat}" onerror="this.style.display='none'">
  <h1>Looking for a<br>${cat.toLowerCase()} in ${city || "your area"}?</h1>
  <p class="hero-sub">Chat's Pick recommends one trusted ${cat.toLowerCase()} per area. No ads. No sponsored listings. Just the one we'd send our own family to.</p>
  <ul class="hero-points">
    <li>One exclusive pick per category per area</li>
    <li>Verified ratings and real Google reviews</li>
    <li>AI-selected based on reputation and trust</li>
    <li>No pay-to-play — businesses earn this spot</li>
  </ul>
  <div class="cta-wrap">
    <a class="cta-btn" href="${revealSlug}">See Chat's Pick →</a>
  </div>
  <p class="trust">Trusted by businesses across 223 categories</p>
</div>
<div class="footer">
  <a href="https://chatspick.com">Chat's Pick</a> · One provider per category per area
  <br><span style="font-size:10px;color:#ddd;">Chat's Pick is a paid co-promotion.</span>
</div>
</body>
</html>`;
}

// ===============================================
// PRODUCTION — Reveal page (Airtable lookup, Active only)
// ===============================================
app.get("/reveal/:category/:zip", async (req, res) => {
  try {
    const category = decodeURIComponent(req.params.category).replace(/-/g, " ").replace(/_/g, " ");
    const zip = req.params.zip;
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
    let revealText = f["Reveal Text"] || "";
    let cityList = "";
    if (revealText.includes("CITIES:")) {
      const parts = revealText.split("CITIES:");
      cityList = parts[1] ? parts[1].trim() : "";
      revealText = parts[0].trim();
    }

    res.send(buildRevealHTML({
      bizName: f["Business Name"] || "",
      cat: f["Category"] || catDisplay,
      city: cityList || f["City"] || "",
      zip: zip,
      phone: f["Phone Number"] || "",
      siteUrl: f["Site URL"] || "",
      address: f["Address"] || "",
      rating: f["Rating"] || "",
      reviews: f["Reviews"] || "",
      revealText: revealText,
      isPreview: false
    }));

  } catch (err) {
    console.error("Reveal page error:", err);
    res.status(500).send("Server error");
  }
});

// ===============================================
// PRODUCTION — Landing page (SEO, Airtable check)
// ===============================================
app.get("/best/:category/:zip", async (req, res) => {
  try {
    const category = decodeURIComponent(req.params.category).replace(/-/g, " ").replace(/_/g, " ");
    const zip = req.params.zip;
    const catDisplay = category.replace(/\b\w/g, c => c.toUpperCase());

    // Check if there's an active pick — if not, still show the page (SEO)
    // but change the CTA
    const filterParts = [
      `{Category} = '${catDisplay}'`,
      `{ZIP / FSA} = '${zip}'`,
      `{Status} = 'Active'`
    ];

    const formula = `AND(${filterParts.join(",")})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&fields%5B%5D=City`;

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const data = await response.json();
    const city = (data.records && data.records.length > 0)
      ? (data.records[0].fields["City"] || "")
      : "";

    res.send(buildLandingHTML({
      cat: catDisplay,
      city: city,
      zip: zip,
      isPreview: false
    }));

  } catch (err) {
    console.error("Landing page error:", err);
    res.status(500).send("Server error");
  }
});

// ===============================================
// PREVIEW — Reveal page (URL params, no Airtable)
// Used by Claude during live demos
// Calls Sonnet on the fly for bullets + city list
// ===============================================
app.get("/preview/reveal/:category/:zip", async (req, res) => {
  const category = decodeURIComponent(req.params.category).replace(/-/g, " ").replace(/_/g, " ");
  const catDisplay = category.replace(/\b\w/g, c => c.toUpperCase());
  const zip = req.params.zip;
  const bizName = req.query.name || "";
  const city = req.query.city || "";
  const phone = req.query.phone || "";
  const siteUrl = req.query.url || "";
  const address = req.query.address || "";
  const rating = req.query.rating || "";
  const reviews = req.query.reviews || "";
  let revealText = req.query.reveal_text || "";

  // If no reveal_text provided, generate on the fly via Sonnet
  if (!revealText && bizName) {
    try {
      const sonnetResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 400,
          system: `Write content for a Chat's Pick reveal page. This is shown to consumers — like a trusted friend recommending this business.

IMPORTANT: Do NOT use the word "best" anywhere. Say "Chat's Pick for [category]" not "Best [category]". Use phrases like "top-rated", "highest-rated", "go-to", "trusted" instead.

SECTION 1 — BULLET POINTS:
Write 4-5 bullet points highlighting why this business stands out. Use the rating, review count, location, and any details you can infer. Sound confident and specific. One bullet per line. No markdown, no numbering, no dashes.

SECTION 2 — TERRITORY:
On a new line, write "CITIES:" followed by a comma-separated list of ALL major cities and communities in the ${zip} ZIP3 area (the first 3 digits of the ZIP code). Include 6-12 cities. These are the cities this business serves as Chat's Pick.

Example output:
Top-rated dentist in the Henderson area with 247 verified Google reviews
Serving families across the Las Vegas valley for over a decade
Known for same-day emergency appointments and gentle care
Locally owned — not a chain
Consistently rated 4.8+ stars by real patients
CITIES: Henderson, Las Vegas, North Las Vegas, Boulder City, Summerlin, Paradise, Spring Valley, Enterprise, Whitney, Anthem`,
          messages: [{ role: "user", content: "Business: " + bizName + "\nCategory: " + catDisplay + "\nCity: " + city + "\nZIP3: " + zip + "\nAddress: " + address + "\nWebsite: " + siteUrl + "\nRating: " + rating + " stars\nReviews: " + reviews + " Google reviews" }]
        })
      });
      const sonnetData = await sonnetResp.json();
      if (sonnetData.content && sonnetData.content[0] && sonnetData.content[0].text) {
        revealText = sonnetData.content[0].text.trim();
      }
    } catch (err) {
      console.error("Sonnet preview error:", err);
    }
  }

  // Extract city list from CITIES: line if present
  let cityList = "";
  if (revealText.includes("CITIES:")) {
    const parts = revealText.split("CITIES:");
    cityList = parts[1] ? parts[1].trim() : "";
    revealText = parts[0].trim();
  }

  res.send(buildRevealHTML({
    bizName: bizName,
    cat: catDisplay,
    city: cityList || city,
    zip: zip,
    phone: phone,
    siteUrl: siteUrl,
    address: address,
    rating: rating,
    reviews: reviews,
    revealText: revealText,
    isPreview: true
  }));
});

// ===============================================
// PREVIEW — Landing page (URL params, no Airtable)
// Used by Claude during live demos
// ===============================================
app.get("/preview/best/:category/:zip", (req, res) => {
  const category = decodeURIComponent(req.params.category).replace(/-/g, " ").replace(/_/g, " ");
  const catDisplay = category.replace(/\b\w/g, c => c.toUpperCase());

  // Pass query string through so preview landing links to preview reveal
  const queryString = new URLSearchParams(req.query).toString();

  res.send(buildLandingHTML({
    cat: catDisplay,
    city: req.query.city || "",
    zip: req.params.zip,
    isPreview: true,
    queryString: queryString
  }));
});

// ===============================================
// Badge image proxy (kill switch on non-payment)
// ===============================================
app.get("/api/badge/:slug", async (req, res) => {
  try {
    const slug = req.params.slug.replace(".png", "");
    const { zip } = req.query;

    if (!zip) {
      // No ZIP = just serve the badge (for generic use)
      return res.sendFile(path.join(__dirname, 'public', 'badges', slug + '.png'), (err) => {
        if (err) res.status(404).send("");
      });
    }

    // Check if slot is active
    const cat = slug.replace(/-/g, " ").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const formula = `AND({Category} = '${cat}', {ZIP / FSA} = '${zip}', {Status} = 'Active')`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&fields%5B%5D=Status`;

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const data = await response.json();

    if (data.records && data.records.length > 0) {
      return res.sendFile(path.join(__dirname, 'public', 'badges', slug + '.png'), (err) => {
        if (err) res.status(404).send("");
      });
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
