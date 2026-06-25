(() => {
  const root = document.getElementById("root");

  // ---------------------------------------------------------------- utilities
  const WORDS = (
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod " +
    "tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam " +
    "quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat " +
    "duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla " +
    "pariatur excepteur sint occaecat cupidatat non proident sunt culpa officia"
  ).split(" ");

  const FIRST = ["Ada", "Grace", "Alan", "Katherine", "Dennis", "Margaret", "Linus", "Barbara", "Ken", "Radia", "Tim", "Hedy"];
  const LAST = ["Lovelace", "Hopper", "Turing", "Johnson", "Ritchie", "Hamilton", "Torvalds", "Liskov", "Thompson", "Perlman", "Berners-Lee", "Lamarr"];
  const REGIONS = ["North America", "South America", "EMEA", "APAC", "Central Europe", "Oceania"];
  const STATUS = ["active", "pending", "blocked", "done", "archived"];
  const PRODUCTS = ["Widget", "Gadget", "Sprocket", "Cog", "Flywheel", "Piston", "Lever", "Valve"];

  let seed = 1337;
  function rand() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const intBetween = (min, max) => min + Math.floor(rand() * (max - min + 1));

  function words(count) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(pick(WORDS));
    const text = out.join(" ");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of [].concat(children)) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function heading(text, badge) {
    const h = el("h2", {}, text);
    if (badge) h.append(el("span", { className: "badge" }, badge));
    root.append(h);
  }

  // ------------------------------------------------------------------- images
  function svgImage(label, bg, fg) {
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'>` +
      `<rect width='600' height='400' fill='${bg}'/>` +
      `<circle cx='180' cy='150' r='90' fill='${fg}' opacity='0.85'/>` +
      `<rect x='300' y='90' width='220' height='150' rx='14' fill='${fg}' opacity='0.55'/>` +
      `<text x='40' y='350' font-family='Arial' font-size='40' font-weight='700' fill='${fg}'>${label}</text>` +
      `</svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function buildImages() {
    heading("Images", "Alt-click to zoom");
    const grid = el("div", { className: "image-grid" });

    const svgs = [
      { label: "SVG · teal", bg: "#dff3ee", fg: "#0f9b8e" },
      { label: "SVG · amber", bg: "#fdf0db", fg: "#d98324" },
      { label: "SVG · indigo", bg: "#e7e9fb", fg: "#4f46e5" }
    ];
    for (const s of svgs) {
      const fig = el("figure", {}, [
        el("img", { src: svgImage(s.label, s.bg, s.fg), alt: s.label }),
        el("figcaption", {}, `${s.label} (inline data URI)`)
      ]);
      grid.append(fig);
    }

    // Remote placeholder photos (picsum.photos — Unsplash-style dummy images).
    for (let i = 0; i < 5; i += 1) {
      const seedName = `altzoom-${i}`;
      const src = `https://picsum.photos/seed/${seedName}/600/400`;
      const fig = el("figure", {}, [
        el("img", { src, alt: `Placeholder photo ${i + 1}`, loading: "lazy", referrerPolicy: "no-referrer" }),
        el("figcaption", {}, `picsum.photos · seed ${seedName}`)
      ]);
      grid.append(fig);
    }

    root.append(grid);
  }

  // ------------------------------------------------------------------- tables
  function buildTable(rows, { num = [] } = {}) {
    const table = el("table", { className: "demo" });
    const thead = el("thead");
    const headTr = el("tr");
    for (const cell of rows[0]) headTr.append(el("th", {}, cell));
    thead.append(headTr);
    const tbody = el("tbody");
    for (let r = 1; r < rows.length; r += 1) {
      const tr = el("tr");
      rows[r].forEach((cell, c) => {
        const td = el("td", {}, cell);
        if (num.includes(c)) td.className = "num";
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    return table;
  }

  // 1) Mixed text lengths in a real <table>.
  function buildProjectsTable() {
    heading("1 · Projects (varying text lengths)", "<table>");
    const rows = [["ID", "Owner", "Status", "Summary"]];
    for (let i = 0; i < 14; i += 1) {
      rows.push([
        `PRJ-${1000 + i}`,
        `${pick(FIRST)} ${pick(LAST)}`,
        pick(STATUS),
        words(intBetween(2, 22))
      ]);
    }
    root.append(buildTable(rows));
  }

  // 2) CSS grid (div display:grid) — no <table> element at all.
  function buildGridTable() {
    heading("2 · CSS grid (div with display:grid)", "div grid");
    const headers = ["Product", "Region", "Units", "Revenue"];
    const grid = el("div", { className: "grid-table" });
    grid.style.gridTemplateColumns = `2fr 2fr 1fr 1fr`;
    for (const h of headers) grid.append(el("div", { className: "gh" }, h));
    for (let i = 0; i < 9; i += 1) {
      const units = intBetween(50, 4000);
      const price = intBetween(8, 90);
      grid.append(el("div", {}, `${pick(PRODUCTS)} ${pick(["A", "B", "C", "X", "Pro", "Mini"])}`));
      grid.append(el("div", {}, pick(REGIONS)));
      grid.append(el("div", {}, units.toLocaleString()));
      grid.append(el("div", {}, `$${(units * price).toLocaleString()}`));
    }
    root.append(grid);
  }

  // 3) Numeric-heavy table for sort/filter testing.
  function buildNumericTable() {
    heading("3 · Sales by region (numbers for sorting)", "<table>");
    const rows = [["Rep", "Region", "Deals", "Quota %", "Revenue"]];
    for (let i = 0; i < 16; i += 1) {
      const deals = intBetween(3, 120);
      const quota = (rand() * 180).toFixed(1);
      const revenue = intBetween(10, 980) * 1000;
      rows.push([
        `${pick(FIRST)} ${pick(LAST)}`,
        pick(REGIONS),
        String(deals),
        `${quota}%`,
        `$${revenue.toLocaleString()}`
      ]);
    }
    root.append(buildTable(rows, { num: [2, 3, 4] }));
  }

  // 4) Very long table to stress row count / scrolling / copy.
  function buildLongTable(rowCount) {
    heading(`4 · Event log (${rowCount.toLocaleString()} rows)`, "long <table>");
    const box = el("div", { className: "scroll-box" });
    const rows = [["#", "Timestamp", "Level", "User", "Message", "Duration (ms)"]];
    const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < rowCount; i += 1) {
      const ts = new Date(baseTime + i * 37000).toISOString().replace("T", " ").slice(0, 19);
      rows.push([
        String(i + 1),
        ts,
        pick(["INFO", "WARN", "ERROR", "DEBUG", "TRACE"]),
        `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase().replace(/[^a-z]/g, "")}`,
        words(intBetween(3, 12)),
        String(intBetween(1, 9000))
      ]);
    }
    box.append(buildTable(rows, { num: [0, 5] }));
    root.append(box);
  }

  // --------------------------------------------------------------------- main
  buildImages();
  buildProjectsTable();
  buildGridTable();
  buildNumericTable();
  buildLongTable(3000);
})();
