(() => {
  const ROOT_ID = "ctm-root";
  const STYLE_ID = "ctm-page-style";
  const LOG_PREFIX = "[alt-table-zoom]";

  if (window.__chromeTableModalInstalled) {
    console.info(LOG_PREFIX, "table content script already installed", location.href);
    return;
  }
  window.__chromeTableModalInstalled = true;
  console.info(LOG_PREFIX, "table content script loaded", { url: location.href });

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  // raw            -> { matrix: Cell[][], headerRowCount: number, sourceType: string }
  // model          -> { columns: Column[], rows: Row[] }
  //   Column       -> { id, originalIndex, label, visible, width, type, align }
  //   Row          -> { cells: Cell[] } indexed by originalIndex
  //   Cell         -> { text, html }
  // view           -> derived array of Row after filter + sort
  let raw = null;
  let model = null;
  let refs = {};
  let viewState = null;
  let lastAltOpenAt = 0;
  let columnsPanelOpen = false;
  let overrideToast = null;

  window.__chromeTableModalDebug = {
    version: "0.1.0",
    loadedAt: new Date().toISOString(),
    getState: () => ({ hasModal: Boolean(document.getElementById(ROOT_ID)), raw, model, viewState })
  };

  // ---------------------------------------------------------------------------
  // Page style (scroll-lock + detection highlight)
  // ---------------------------------------------------------------------------
  function installPageStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      body.ctm-modal-open { overflow: hidden !important; }
      .ctm-source-flash {
        outline: 4px solid #6c8cff !important;
        outline-offset: 3px !important;
        transition: outline-color 120ms ease !important;
      }
    `;
    document.documentElement.append(style);
  }

  // ---------------------------------------------------------------------------
  // Detection: find the table-like element under an Alt-click
  // ---------------------------------------------------------------------------
  function isAriaTable(el) {
    const role = el.getAttribute?.("role");
    return role === "table" || role === "grid" || role === "treegrid";
  }

  function isGridContainer(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const display = getComputedStyle(el).display;
    if (display !== "grid" && display !== "inline-grid") return false;
    // Must have at least a couple of laid-out children to be worth treating as a table.
    const kids = [...el.children].filter((c) => c.getClientRects().length);
    return kids.length >= 2;
  }

  function findTableLike(startEl) {
    let el = startEl;
    let gridCandidate = null;
    while (el && el.nodeType === Node.ELEMENT_NODE && el !== document.body) {
      if (el.tagName === "TABLE") return { el, kind: "table" };
      if (isAriaTable(el)) return { el, kind: "aria" };
      if (!gridCandidate && isGridContainer(el)) gridCandidate = el;
      el = el.parentElement;
    }
    if (gridCandidate) return { el: gridCandidate, kind: "grid" };
    return null;
  }

  function findAltTable(event) {
    const path = event.composedPath?.() || [];
    for (const node of path) {
      if (node?.nodeType !== Node.ELEMENT_NODE) continue;
      const found = findTableLike(node);
      if (found) return found;
    }
    const target = document.elementFromPoint?.(event.clientX, event.clientY);
    return target ? findTableLike(target) : null;
  }

  // ---------------------------------------------------------------------------
  // Extraction helpers
  // ---------------------------------------------------------------------------
  function cellText(el) {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return text;
  }

  function makeCell(el) {
    return { text: cellText(el), html: el.innerHTML };
  }

  // Real <table> -> matrix with colspan/rowspan expansion.
  function extractTable(table) {
    const matrix = [];
    const trs = [...table.rows];
    for (let r = 0; r < trs.length; r += 1) {
      const cells = [...trs[r].cells];
      let c = 0;
      for (const cell of cells) {
        matrix[r] = matrix[r] || [];
        while (matrix[r][c] !== undefined) c += 1;
        const colspan = Math.max(1, cell.colSpan || 1);
        const rowspan = Math.max(1, cell.rowSpan || 1);
        const data = makeCell(cell);
        const isHeader = cell.tagName === "TH";
        for (let dr = 0; dr < rowspan; dr += 1) {
          for (let dc = 0; dc < colspan; dc += 1) {
            matrix[r + dr] = matrix[r + dr] || [];
            matrix[r + dr][c + dc] = dr === 0 && dc === 0
              ? { ...data, isHeader }
              : { text: "", html: "", isHeader, spanned: true };
          }
        }
        c += colspan;
      }
    }
    const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    for (const row of matrix) {
      for (let i = 0; i < width; i += 1) if (!row[i]) row[i] = { text: "", html: "" };
    }

    // Header rows: prefer <thead>, else count leading all-<th> rows.
    let headerRowCount = 0;
    if (table.tHead && table.tHead.rows.length) {
      headerRowCount = table.tHead.rows.length;
    } else {
      for (const row of matrix) {
        if (row.length && row.every((cell) => cell.isHeader || cell.spanned)) headerRowCount += 1;
        else break;
      }
    }
    return { matrix, headerRowCount: headerRowCount > 0 ? 1 : 0, sourceType: "table" };
  }

  // Group arbitrary elements into rows by their vertical position.
  function rowsByPosition(elements) {
    const items = elements
      .filter((el) => el.getClientRects().length)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, top: rect.top, left: rect.left };
      });
    items.sort((a, b) => a.top - b.top || a.left - b.left);

    const rows = [];
    let current = null;
    let currentTop = null;
    for (const item of items) {
      if (current === null || Math.abs(item.top - currentTop) > 6) {
        current = [];
        currentTop = item.top;
        rows.push(current);
      }
      current.push(item);
    }
    return rows.map((row) => row.sort((a, b) => a.left - b.left).map((it) => it.el));
  }

  function matrixFromRowElements(rowEls) {
    const matrix = rowEls.map((cells) => cells.map((el) => makeCell(el)));
    const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    for (const row of matrix) {
      for (let i = 0; i < width; i += 1) if (!row[i]) row[i] = { text: "", html: "" };
    }
    return matrix;
  }

  function extractAria(root) {
    const rowEls = [...root.querySelectorAll('[role="row"]')];
    let rows;
    if (rowEls.length) {
      rows = rowEls.map((rowEl) =>
        [...rowEl.querySelectorAll('[role="columnheader"], [role="rowheader"], [role="cell"], [role="gridcell"]')]
      );
    } else {
      rows = rowsByPosition([...root.children]);
    }
    const matrix = matrixFromRowElements(rows);
    const firstHasHeader = rowEls.length
      ? rowEls[0].querySelector('[role="columnheader"]') != null
      : true;
    return { matrix, headerRowCount: firstHasHeader ? 1 : 0, sourceType: "aria" };
  }

  function extractGrid(root) {
    const rows = rowsByPosition([...root.children]);
    const matrix = matrixFromRowElements(rows);
    return { matrix, headerRowCount: 1, sourceType: "grid" };
  }

  function extract(found) {
    if (found.kind === "table") return extractTable(found.el);
    if (found.kind === "aria") return extractAria(found.el);
    return extractGrid(found.el);
  }

  // ---------------------------------------------------------------------------
  // Model building (matrix + options -> columns/rows)
  // ---------------------------------------------------------------------------
  function parseNumber(text) {
    if (text == null) return null;
    const trimmed = String(text).trim();
    if (!trimmed) return null;
    let negative = false;
    let s = trimmed;
    if (/^\(.*\)$/.test(s)) {
      negative = true;
      s = s.slice(1, -1);
    }
    if (/^-/.test(s)) {
      negative = true;
      s = s.slice(1);
    }
    const cleaned = s.replace(/[^0-9.]/g, "");
    if (!cleaned || !/[0-9]/.test(cleaned) || (cleaned.match(/\./g) || []).length > 1) return null;
    const value = parseFloat(cleaned);
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
  }

  function detectColumnType(rows, originalIndex) {
    let numeric = 0;
    let total = 0;
    for (const row of rows) {
      const text = row.cells[originalIndex]?.text || "";
      if (!text) continue;
      total += 1;
      if (parseNumber(text) !== null) numeric += 1;
    }
    if (total === 0) return "text";
    return numeric / total >= 0.6 ? "number" : "text";
  }

  function buildModel(useFirstRowAsHeader) {
    const matrix = raw.matrix;
    const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    const headerRowIndex = useFirstRowAsHeader && matrix.length ? 0 : -1;

    const headerCells = headerRowIndex >= 0 ? matrix[headerRowIndex] : null;
    const bodyMatrix = matrix.filter((_, idx) => idx !== headerRowIndex);

    const rows = bodyMatrix.map((row) => {
      const cells = [];
      for (let i = 0; i < width; i += 1) cells[i] = row[i] || { text: "", html: "" };
      return { cells };
    });

    const columns = [];
    for (let i = 0; i < width; i += 1) {
      const label = (headerCells && headerCells[i]?.text) || `Column ${i + 1}`;
      const type = detectColumnType(rows, i);
      columns.push({
        id: `c${i}`,
        originalIndex: i,
        label,
        visible: true,
        width: null,
        type,
        align: type === "number" ? "right" : "left"
      });
    }

    model = { columns, rows };
    console.info(LOG_PREFIX, "model built", {
      columns: columns.length,
      rows: rows.length,
      sourceType: raw.sourceType,
      useFirstRowAsHeader
    });
  }

  // ---------------------------------------------------------------------------
  // View derivation (filter + sort)
  // ---------------------------------------------------------------------------
  function visibleColumnsInOrder() {
    return model.columns.filter((col) => col.visible);
  }

  function computeView() {
    let rows = model.rows;
    const search = viewState.search.trim().toLowerCase();
    const filters = viewState.filters;
    const filterEntries = Object.entries(filters).filter(([, value]) => value && value.trim());

    if (search || filterEntries.length) {
      const searchCols = visibleColumnsInOrder();
      rows = rows.filter((row) => {
        if (search) {
          const hit = searchCols.some((col) => (row.cells[col.originalIndex]?.text || "").toLowerCase().includes(search));
          if (!hit) return false;
        }
        for (const [colId, value] of filterEntries) {
          const col = model.columns.find((c) => c.id === colId);
          if (!col) continue;
          const text = (row.cells[col.originalIndex]?.text || "").toLowerCase();
          if (!text.includes(value.trim().toLowerCase())) return false;
        }
        return true;
      });
    }

    if (viewState.sort) {
      const { colId, dir } = viewState.sort;
      const col = model.columns.find((c) => c.id === colId);
      if (col) {
        const factor = dir === "desc" ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const ta = a.cells[col.originalIndex]?.text || "";
          const tb = b.cells[col.originalIndex]?.text || "";
          if (col.type === "number") {
            const na = parseNumber(ta);
            const nb = parseNumber(tb);
            if (na === null && nb === null) return 0;
            if (na === null) return 1;
            if (nb === null) return -1;
            return (na - nb) * factor;
          }
          return ta.localeCompare(tb, undefined, { numeric: true, sensitivity: "base" }) * factor;
        });
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function button(label, className, onClick, title = label) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className || "ctm-button";
    el.textContent = label;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.addEventListener("click", onClick);
    return el;
  }

  function renderShell() {
    removeModalDom();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "ctm-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Table viewer");

    const dialog = document.createElement("div");
    dialog.className = "ctm-dialog";

    const header = document.createElement("header");
    header.className = "ctm-header";

    const body = document.createElement("div");
    body.className = "ctm-body";

    const tableWrap = document.createElement("div");
    tableWrap.className = "ctm-table-wrap";
    body.append(tableWrap);

    dialog.append(header, body);
    root.append(dialog);
    document.documentElement.append(root);
    document.body.classList.add("ctm-modal-open");

    refs = { root, dialog, header, body, tableWrap };

    renderToolbar();
    renderTable();

    root.addEventListener("click", (event) => {
      if (event.target === root) closeModal();
    });
    document.addEventListener("keydown", handleKeydown, true);
  }

  function renderToolbar() {
    const header = refs.header;
    header.textContent = "";

    const left = document.createElement("div");
    left.className = "ctm-toolbar-group";

    const title = document.createElement("h2");
    title.className = "ctm-title";
    title.textContent = "Table";

    const columnsBtn = button("Columns ▾", "ctm-button ctm-columns-toggle", toggleColumnsPanel, "Show / hide columns");
    columnsBtn.setAttribute("aria-pressed", String(columnsPanelOpen));
    refs.columnsToggle = columnsBtn;

    const filterBtn = button(
      viewState.filtersVisible ? "Filters ✓" : "Filters",
      "ctm-button",
      () => {
        viewState.filtersVisible = !viewState.filtersVisible;
        renderToolbar();
        renderTable();
      },
      "Toggle per-column filter row"
    );
    if (viewState.filtersVisible) filterBtn.classList.add("ctm-button-active");

    left.append(title, columnsBtn, filterBtn);

    const center = document.createElement("div");
    center.className = "ctm-toolbar-group ctm-toolbar-search";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "ctm-search";
    search.placeholder = "Search all visible columns…";
    search.value = viewState.search;
    search.addEventListener("input", () => {
      viewState.search = search.value;
      renderTableBody();
      updateRowCount();
    });
    center.append(search);

    const right = document.createElement("div");
    right.className = "ctm-toolbar-group";

    const count = document.createElement("span");
    count.className = "ctm-badge ctm-row-count";
    refs.rowCount = count;

    const copyCsv = button("CSV", "ctm-button", () => copyView("csv"), "Copy current view as CSV");
    const copyTsv = button("TSV", "ctm-button", () => copyView("tsv"), "Copy current view as TSV");
    const copyHtml = button("HTML", "ctm-button", () => copyView("html"), "Copy current view as HTML table");
    const reset = button("Reset", "ctm-button", resetView, "Reset sort, filters, columns");
    const close = button("Close", "ctm-button ctm-close-button", closeModal, "Close");

    right.append(count, copyCsv, copyTsv, copyHtml, reset, close);

    header.append(left, center, right);
    updateRowCount();

    if (columnsPanelOpen) renderColumnsPanel();
  }

  function updateRowCount() {
    if (!refs.rowCount) return;
    const total = model.rows.length;
    const shown = computeView().length;
    const cols = visibleColumnsInOrder().length;
    refs.rowCount.textContent = shown === total
      ? `${total} rows · ${cols} cols`
      : `${shown} / ${total} rows · ${cols} cols`;
  }

  function toggleColumnsPanel() {
    if (columnsPanelOpen) {
      closeColumnsPanel();
    } else {
      columnsPanelOpen = true;
      renderToolbar();
    }
  }

  function closeColumnsPanel() {
    columnsPanelOpen = false;
    refs.columnsPanel?.remove();
    refs.columnsPanel = null;
    refs.columnsToggle?.setAttribute("aria-pressed", "false");
    document.removeEventListener("pointerdown", handleColumnsOutside, true);
  }

  function handleColumnsOutside(event) {
    if (refs.columnsPanel?.contains(event.target)) return;
    if (refs.columnsToggle?.contains(event.target)) return; // let the toggle handle it
    closeColumnsPanel();
  }

  function renderColumnsPanel() {
    refs.columnsPanel?.remove();
    const panel = document.createElement("div");
    panel.className = "ctm-columns-panel";

    const header = document.createElement("div");
    header.className = "ctm-columns-panel-head";
    const heading = document.createElement("strong");
    heading.textContent = "Columns";
    const headerToggle = document.createElement("label");
    headerToggle.className = "ctm-check-row";
    const headerCheck = document.createElement("input");
    headerCheck.type = "checkbox";
    headerCheck.checked = viewState.useFirstRowAsHeader;
    headerCheck.addEventListener("change", () => {
      viewState.useFirstRowAsHeader = headerCheck.checked;
      rebuildFromOptions();
    });
    headerToggle.append(headerCheck, document.createTextNode("Use first row as header"));
    header.append(heading, headerToggle);

    const allRow = document.createElement("div");
    allRow.className = "ctm-columns-panel-actions";
    allRow.append(
      button("Show all", "ctm-mini-button", () => {
        model.columns.forEach((c) => (c.visible = true));
        renderTable();
        renderColumnsPanel();
        updateRowCount();
      }),
      button("Hide all", "ctm-mini-button", () => {
        model.columns.forEach((c, i) => (c.visible = i === 0));
        renderTable();
        renderColumnsPanel();
        updateRowCount();
      })
    );

    const list = document.createElement("div");
    list.className = "ctm-columns-list";
    model.columns.forEach((col) => {
      const row = document.createElement("label");
      row.className = "ctm-check-row";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = col.visible;
      check.addEventListener("change", () => {
        col.visible = check.checked;
        renderTable();
        updateRowCount();
      });
      const name = document.createElement("span");
      name.className = "ctm-columns-label";
      name.textContent = col.label || col.id;
      const type = document.createElement("span");
      type.className = "ctm-columns-type";
      type.textContent = col.type;
      row.append(check, name, type);
      list.append(row);
    });

    panel.append(header, allRow, list);
    panel.addEventListener("click", (e) => e.stopPropagation());
    refs.dialog.append(panel);
    refs.columnsPanel = panel;
    document.addEventListener("pointerdown", handleColumnsOutside, true);
  }

  function rebuildFromOptions() {
    // Preserve current visibility/order/width by column originalIndex where possible.
    const prev = model ? model.columns.map((c) => ({ ...c })) : null;
    buildModel(viewState.useFirstRowAsHeader);
    if (prev) {
      // Carry over the previous column order, visibility, and widths by original index.
      const reordered = [];
      for (const old of prev) {
        const next = model.columns.find((c) => c.originalIndex === old.originalIndex);
        if (next) {
          next.visible = old.visible;
          next.width = old.width;
          reordered.push(next);
        }
      }
      for (const col of model.columns) {
        if (!reordered.includes(col)) reordered.push(col);
      }
      model.columns = reordered;
    }
    if (viewState.sort && !model.columns.some((c) => c.id === viewState.sort.colId)) viewState.sort = null;
    renderTable();
    renderColumnsPanel();
    updateRowCount();
  }

  function renderTable() {
    const wrap = refs.tableWrap;
    wrap.textContent = "";

    const table = document.createElement("table");
    table.className = "ctm-table";

    const colgroup = document.createElement("colgroup");
    const cols = visibleColumnsInOrder();
    cols.forEach((col) => {
      const colEl = document.createElement("col");
      if (col.width) colEl.style.width = `${col.width}px`;
      colgroup.append(colEl);
    });
    table.append(colgroup);

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    cols.forEach((col, displayIndex) => {
      headRow.append(renderHeaderCell(col, displayIndex));
    });
    thead.append(headRow);

    if (viewState.filtersVisible) {
      const filterRow = document.createElement("tr");
      filterRow.className = "ctm-filter-row";
      cols.forEach((col) => {
        const cell = document.createElement("th");
        const input = document.createElement("input");
        input.type = "text";
        input.className = "ctm-col-filter";
        input.placeholder = "filter…";
        input.value = viewState.filters[col.id] || "";
        input.addEventListener("input", () => {
          viewState.filters[col.id] = input.value;
          renderTableBody();
          updateRowCount();
        });
        cell.append(input);
        filterRow.append(cell);
      });
      thead.append(filterRow);
    }

    const tbody = document.createElement("tbody");
    tbody.className = "ctm-tbody";

    table.append(thead, tbody);
    wrap.append(table);
    refs.table = table;
    refs.colgroup = colgroup;
    refs.tbody = tbody;

    renderTableBody();
    initColumnWidths();
  }

  function renderHeaderCell(col, displayIndex) {
    const th = document.createElement("th");
    th.className = "ctm-th";
    th.dataset.colId = col.id;
    th.dataset.displayIndex = String(displayIndex);
    th.style.textAlign = col.align;
    th.draggable = true;

    const inner = document.createElement("div");
    inner.className = "ctm-th-inner";

    const labelBtn = document.createElement("button");
    labelBtn.type = "button";
    labelBtn.className = "ctm-th-label";
    labelBtn.textContent = col.label || col.id;
    labelBtn.title = `Sort by ${col.label || col.id}`;
    labelBtn.addEventListener("click", () => cycleSort(col.id));

    const arrow = document.createElement("span");
    arrow.className = "ctm-sort-arrow";
    if (viewState.sort?.colId === col.id) {
      arrow.textContent = viewState.sort.dir === "asc" ? "▲" : "▼";
    }

    inner.append(labelBtn, arrow);
    th.append(inner);

    const resizer = document.createElement("span");
    resizer.className = "ctm-resizer";
    resizer.addEventListener("pointerdown", (e) => startResize(e, col, th));
    resizer.addEventListener("click", (e) => e.stopPropagation());
    resizer.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      col.width = null;
      renderTable();
    });
    th.append(resizer);

    // Drag-reorder
    th.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", col.id);
      th.classList.add("ctm-th-dragging");
    });
    th.addEventListener("dragend", () => {
      th.classList.remove("ctm-th-dragging");
      refs.table?.querySelectorAll(".ctm-th-drop-before, .ctm-th-drop-after")
        .forEach((el) => el.classList.remove("ctm-th-drop-before", "ctm-th-drop-after"));
    });
    th.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = th.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      th.classList.toggle("ctm-th-drop-after", after);
      th.classList.toggle("ctm-th-drop-before", !after);
    });
    th.addEventListener("dragleave", () => {
      th.classList.remove("ctm-th-drop-before", "ctm-th-drop-after");
    });
    th.addEventListener("drop", (e) => {
      e.preventDefault();
      const sourceId = e.dataTransfer.getData("text/plain");
      const rect = th.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      reorderColumn(sourceId, col.id, after);
    });

    return th;
  }

  function renderTableBody() {
    if (!refs.tbody) return;
    const cols = visibleColumnsInOrder();
    const rows = computeView();
    const frag = document.createDocumentFragment();

    const MAX_RENDER = 5000;
    const slice = rows.slice(0, MAX_RENDER);
    for (const row of slice) {
      const tr = document.createElement("tr");
      for (const col of cols) {
        const td = document.createElement("td");
        td.className = "ctm-td";
        td.style.textAlign = col.align;
        const text = row.cells[col.originalIndex]?.text || "";
        td.textContent = text;
        td.title = text;
        tr.append(td);
      }
      frag.append(tr);
    }
    refs.tbody.textContent = "";
    refs.tbody.append(frag);

    refs.truncNote?.remove();
    refs.truncNote = null;
    if (rows.length > MAX_RENDER) {
      const note = document.createElement("div");
      note.className = "ctm-trunc-note";
      note.textContent = `Showing first ${MAX_RENDER} of ${rows.length} rows (copy still exports all matching rows).`;
      refs.tableWrap.append(note);
      refs.truncNote = note;
    }
  }

  function initColumnWidths() {
    const cols = visibleColumnsInOrder();
    if (cols.every((c) => c.width)) {
      refs.table.style.tableLayout = "fixed";
      return;
    }
    // Measure natural widths once, then lock to fixed layout.
    requestAnimationFrame(() => {
      if (!refs.table || !refs.colgroup) return;
      const ths = refs.table.querySelectorAll("thead tr:first-child th");
      const colEls = refs.colgroup.children;
      ths.forEach((th, i) => {
        const col = cols[i];
        const measured = Math.max(80, Math.min(520, Math.round(th.getBoundingClientRect().width)));
        col.width = col.width || measured;
        if (colEls[i]) colEls[i].style.width = `${col.width}px`;
      });
      refs.table.style.tableLayout = "fixed";
    });
  }

  function startResize(event, col, th) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    const displayIndex = Number(th.dataset.displayIndex);
    const colEl = refs.colgroup.children[displayIndex];
    refs.table.style.tableLayout = "fixed";
    document.body.classList.add("ctm-col-resizing");

    function onMove(e) {
      const next = Math.max(48, Math.round(startWidth + (e.clientX - startX)));
      col.width = next;
      if (colEl) colEl.style.width = `${next}px`;
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.body.classList.remove("ctm-col-resizing");
    }
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
  }

  function cycleSort(colId) {
    const current = viewState.sort;
    if (!current || current.colId !== colId) {
      viewState.sort = { colId, dir: "asc" };
    } else if (current.dir === "asc") {
      viewState.sort = { colId, dir: "desc" };
    } else {
      viewState.sort = null;
    }
    renderTable();
    updateRowCount();
  }

  function reorderColumn(sourceId, targetId, after) {
    if (sourceId === targetId) return;
    const cols = model.columns;
    const fromIndex = cols.findIndex((c) => c.id === sourceId);
    if (fromIndex < 0) return;
    const [moved] = cols.splice(fromIndex, 1);
    let targetIndex = cols.findIndex((c) => c.id === targetId);
    if (targetIndex < 0) {
      cols.splice(fromIndex, 0, moved);
      return;
    }
    if (after) targetIndex += 1;
    cols.splice(targetIndex, 0, moved);
    renderTable();
  }

  function resetView() {
    viewState.sort = null;
    viewState.filters = {};
    viewState.search = "";
    viewState.useFirstRowAsHeader = raw.headerRowCount > 0;
    buildModel(viewState.useFirstRowAsHeader);
    renderToolbar();
    renderTable();
  }

  // ---------------------------------------------------------------------------
  // Copy / export (always reflects the current on-screen view)
  // ---------------------------------------------------------------------------
  function viewMatrix() {
    const cols = visibleColumnsInOrder();
    const rows = computeView();
    const header = cols.map((c) => c.label || c.id);
    const body = rows.map((row) => cols.map((col) => row.cells[col.originalIndex]?.text || ""));
    return { header, body };
  }

  function toDelimited(matrix, delimiter) {
    const escape = (value) => {
      const s = String(value ?? "");
      if (delimiter === "," && /[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      if (delimiter === "\t") return s.replace(/\t/g, " ").replace(/\r?\n/g, " ");
      return s;
    };
    return [matrix.header, ...matrix.body]
      .map((row) => row.map(escape).join(delimiter))
      .join("\n");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function toHtml(matrix) {
    const head = `<tr>${matrix.header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
    const body = matrix.body
      .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
      .join("");
    return `<table border="1" cellspacing="0" cellpadding="4"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  async function copyView(format) {
    const matrix = viewMatrix();
    try {
      if (format === "html") {
        const html = toHtml(matrix);
        const plain = toDelimited(matrix, "\t");
        if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([html], { type: "text/html" }),
              "text/plain": new Blob([plain], { type: "text/plain" })
            })
          ]);
        } else {
          await navigator.clipboard.writeText(html);
        }
        showToast("Copied HTML table");
        return;
      }
      const delimiter = format === "csv" ? "," : "\t";
      await navigator.clipboard.writeText(toDelimited(matrix, delimiter));
      showToast(`Copied ${format.toUpperCase()} (${matrix.body.length} rows)`);
    } catch (error) {
      console.warn(LOG_PREFIX, "copy failed", error);
      showToast(error.message || "Unable to copy", true);
    }
  }

  function showToast(message, isError = false) {
    if (!refs.root) return;
    const toast = document.createElement("div");
    toast.className = `ctm-toast${isError ? " ctm-toast-error" : ""}`;
    toast.textContent = message;
    refs.root.append(toast);
    setTimeout(() => toast.remove(), 2800);
  }

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------
  // Heuristic: is a CSS-grid container likely real tabular text content (worth a
  // table viewer), versus a layout grid / image gallery? Only applied to grids;
  // real <table> and ARIA grids are always honored.
  function gridLooksTabular(matrix) {
    const rowCount = matrix.length;
    const colCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    if (colCount < 2) return { ok: false, reason: "only one column detected" };
    if (rowCount < 2) return { ok: false, reason: "only one row detected" };

    let totalCells = 0;
    let mediaCells = 0;
    let textCells = 0;
    let totalTextLength = 0;
    for (const row of matrix) {
      for (const cell of row) {
        totalCells += 1;
        if (/<(img|svg|video|canvas|picture|iframe)\b/i.test(cell.html || "")) mediaCells += 1;
        const text = (cell.text || "").trim();
        if (text) {
          textCells += 1;
          totalTextLength += text.length;
        }
      }
    }
    if (!totalCells) return { ok: false, reason: "no cells found" };
    if (mediaCells / totalCells >= 0.4) return { ok: false, reason: "looks like an image gallery" };
    if (textCells / totalCells < 0.4) return { ok: false, reason: "too few cells contain text" };
    if (totalTextLength < 6) return { ok: false, reason: "almost no text content" };
    return { ok: true };
  }

  function openForElement(found, force = false) {
    const extracted = extract(found);
    if (!extracted.matrix.length) {
      console.warn(LOG_PREFIX, "no rows extracted", found);
      return false;
    }

    if (!force && found.kind === "grid") {
      const verdict = gridLooksTabular(extracted.matrix);
      if (!verdict.ok) {
        console.info(LOG_PREFIX, "grid blocked by heuristic", verdict.reason);
        showOverrideToast(found, verdict.reason);
        return false;
      }
    }

    dismissOverrideToast();
    raw = extracted;
    viewState = {
      sort: null,
      filters: {},
      search: "",
      filtersVisible: false,
      useFirstRowAsHeader: raw.headerRowCount > 0
    };
    columnsPanelOpen = false;
    buildModel(viewState.useFirstRowAsHeader);
    renderShell();
    return true;
  }

  // Floating page-level prompt shown when a grid is blocked by the heuristic.
  // Clicking it forces the table viewer open for that element.
  function showOverrideToast(found, reason) {
    dismissOverrideToast();

    const toast = document.createElement("div");
    toast.className = "ctm-override-toast";
    toast.setAttribute("role", "button");
    toast.tabIndex = 0;

    const title = document.createElement("div");
    title.className = "ctm-override-title";
    title.textContent = "Not a table?";

    const body = document.createElement("div");
    body.className = "ctm-override-body";
    body.textContent = `This grid ${reason}. Click to open it anyway.`;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ctm-override-close";
    close.textContent = "✕";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      dismissOverrideToast();
    });

    const force = () => {
      dismissOverrideToast();
      openForElement(found, true);
    };
    toast.addEventListener("click", force);
    toast.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        force();
      }
    });

    toast.append(close, title, body);
    document.documentElement.append(toast);
    overrideToast = toast;
    overrideToast.timer = setTimeout(dismissOverrideToast, 8000);
  }

  function dismissOverrideToast() {
    if (!overrideToast) return;
    clearTimeout(overrideToast.timer);
    overrideToast.remove();
    overrideToast = null;
  }

  function handleKeydown(event) {
    if (!model) return;
    if (event.key === "Escape") {
      // Consume the key entirely so it can't reach the underlying app.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (columnsPanelOpen) {
        toggleColumnsPanel();
      } else {
        closeModal();
      }
    }
  }

  function closeModal() {
    removeModalDom();
    dismissOverrideToast();
    refs = {};
    raw = null;
    model = null;
    viewState = null;
    columnsPanelOpen = false;
  }

  function removeModalDom() {
    const existing = document.getElementById(ROOT_ID);
    if (existing) existing.remove();
    document.body?.classList.remove("ctm-modal-open");
    document.removeEventListener("keydown", handleKeydown, true);
    document.removeEventListener("pointerdown", handleColumnsOutside, true);
  }

  // ---------------------------------------------------------------------------
  // Alt-click activation (independent from the image modal)
  // ---------------------------------------------------------------------------
  function handleAltActivation(event, trigger) {
    if (!event.altKey || event.button !== 0) return false;

    // Never act on clicks that land inside either modal overlay (e.g. the image
    // modal, whose own layout uses display:grid and would otherwise be detected
    // as a "table").
    if (event.target?.closest?.("#ctm-root, #cim-root")) return false;

    const now = Date.now();

    // A single physical Alt-click fires pointerdown -> mousedown -> click as
    // three separate events. Once we have claimed a table for this gesture,
    // swallow the whole trio so the image modal (which runs after us) never
    // acts on the same click.
    if (now - lastAltOpenAt < 700) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    }

    if (model) return false; // already open from an earlier gesture

    // The image modal claimed this gesture (it opens on pointerdown and covers
    // the screen); don't spawn a table viewer underneath it.
    if (document.getElementById("cim-root")) return false;

    // If the user genuinely clicked an image/video, defer to the image modal.
    const directImage = event.target?.closest?.("img, video");
    if (directImage) return false;

    const found = findAltTable(event);
    if (!found) return false;

    lastAltOpenAt = now;

    console.info(LOG_PREFIX, `Alt-${trigger} matched table-like element`, {
      kind: found.kind,
      tag: found.el.tagName
    });

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openForElement(found);
    return true;
  }

  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    handleAltActivation(event, "pointerdown");
  }, true);
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    handleAltActivation(event, "mousedown");
  }, true);
  document.addEventListener("click", (event) => {
    handleAltActivation(event, "click");
  }, true);

  installPageStyle();
})();
