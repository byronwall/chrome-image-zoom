(() => {
  const ROOT_ID = "cim-root";
  const STYLE_ID = "cim-page-style";
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 8;
  const ZOOM_IN_FACTOR = 1.25;
  const ZOOM_OUT_FACTOR = 0.8;
  const LOG_PREFIX = "[alt-image-zoom]";

  if (window.__chromeImageModalInstalled) {
    console.info(LOG_PREFIX, "content script already installed", location.href);
    return;
  }
  window.__chromeImageModalInstalled = true;
  console.info(LOG_PREFIX, "content script loaded", {
    url: location.href,
    imageCount: document.images.length
  });

  let state = null;
  let refs = {};
  let imageNaturalSize = null;
  let stageSize = null;
  let scale = 1;
  let offset = { x: 0, y: 0 };
  let isFitView = true;
  let panSession = null;
  let resizeObserver = null;
  let preloadRequestId = 0;
  let lastAltOpenAt = 0;
  let foldersCache = [];
  let selectedFolderId = localStorage.getItem("cim-selected-folder-id") || "";

  window.__chromeImageModalDebug = {
    version: "0.1.0",
    loadedAt: new Date().toISOString(),
    openByUrl: openModalForImageUrl,
    getState: () => ({
      hasModal: Boolean(document.getElementById(ROOT_ID)),
      imageCount: document.images.length,
      state
    })
  };

  function installPageStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      img[data-cim-hoverable="true"] { cursor: zoom-in !important; }
      body.cim-modal-open { overflow: hidden !important; }
    `;
    document.documentElement.append(style);
  }

  function normalizeUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return "";
    }
  }

  function getBestImageSrc(img) {
    return normalizeUrl(img.currentSrc || img.src || img.getAttribute("src") || "");
  }

  function sourcesMatch(left, right) {
    const normalizedLeft = normalizeUrl(left);
    const normalizedRight = normalizeUrl(right);
    if (normalizedLeft && normalizedRight && normalizedLeft === normalizedRight) return true;
    return left === right;
  }

  function getAltOrName(img, src, index) {
    const alt = (img.getAttribute("alt") || img.getAttribute("aria-label") || "").trim();
    if (alt) return alt;
    try {
      const pathname = new URL(src).pathname;
      const name = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
      if (name) return name;
    } catch {
      // Fall through to generic name.
    }
    return `Image ${index + 1}`;
  }

  function collectImages(activeSrc) {
    const seen = new Set();
    const images = [];

    for (const img of document.images) {
      const src = getBestImageSrc(img);
      if (!src || seen.has(src)) continue;

      const rect = img.getBoundingClientRect();
      const naturalWidth = img.naturalWidth || 0;
      const naturalHeight = img.naturalHeight || 0;
      const renderedArea = Math.max(0, rect.width) * Math.max(0, rect.height);
      const naturalArea = naturalWidth * naturalHeight;

      if (src !== activeSrc && renderedArea < 100 && naturalArea < 10000) continue;

      seen.add(src);
      images.push({
        src,
        title: getAltOrName(img, src, images.length),
        alt: (img.getAttribute("alt") || "").trim(),
        naturalWidth,
        naturalHeight,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height)
      });
    }

    const activeIndex = Math.max(0, images.findIndex((item) => item.src === activeSrc));
    console.info(LOG_PREFIX, "collected page images", {
      activeSrc,
      imageCount: images.length,
      activeIndex
    });
    return { images, activeIndex };
  }

  function findBestPageImage() {
    let best = null;
    let bestScore = 0;

    for (const img of document.images) {
      const src = getBestImageSrc(img);
      if (!src) continue;

      const rect = img.getBoundingClientRect();
      const renderedArea = Math.max(0, rect.width) * Math.max(0, rect.height);
      const naturalArea = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const visibleArea = visibleWidth * visibleHeight;
      const score = visibleArea * 3 + renderedArea + naturalArea * 0.05;

      if (score > bestScore) {
        best = img;
        bestScore = score;
      }
    }

    return best;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatPercent(value) {
    return `${Math.round(value * 100)}%`;
  }

  function formatDimensions(item) {
    const width = imageNaturalSize?.width || item.naturalWidth || item.renderedWidth;
    const height = imageNaturalSize?.height || item.naturalHeight || item.renderedHeight;
    return width && height ? `${width} x ${height}` : "Unknown size";
  }

  function getMimeType(item) {
    const src = item.src.split("?")[0].split("#")[0].toLowerCase();
    if (src.endsWith(".jpg") || src.endsWith(".jpeg")) return "image/jpeg";
    if (src.endsWith(".png")) return "image/png";
    if (src.endsWith(".gif")) return "image/gif";
    if (src.endsWith(".webp")) return "image/webp";
    if (src.endsWith(".svg")) return "image/svg+xml";
    if (src.startsWith("data:")) return src.slice(5, src.indexOf(";")) || "image";
    return "image";
  }

  function getFileName(item) {
    let base = item.title || "image";
    try {
      const url = new URL(item.src);
      const leaf = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      if (leaf) base = leaf;
    } catch {
      // Keep title fallback.
    }
    base = base
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    return base || "image";
  }

  function fitScale() {
    if (!stageSize || !imageNaturalSize) return 1;
    const widthScale = stageSize.width / imageNaturalSize.width;
    const heightScale = stageSize.height / imageNaturalSize.height;
    return Math.min(1, widthScale, heightScale, MAX_SCALE);
  }

  function computedMinScale() {
    return Math.min(MIN_SCALE, fitScale());
  }

  function resetView() {
    const nextScale = fitScale();
    scale = nextScale;
    offset = { x: 0, y: 0 };
    isFitView = true;
    renderViewport();
  }

  function zoomAt(factor, anchor) {
    if (!stageSize) return;
    const oldScale = scale;
    const nextScale = clamp(oldScale * factor, computedMinScale(), MAX_SCALE);
    if (nextScale === oldScale) return;

    const stageCenter = { x: stageSize.width / 2, y: stageSize.height / 2 };
    const point = anchor || stageCenter;
    const dx = point.x - stageCenter.x - offset.x;
    const dy = point.y - stageCenter.y - offset.y;
    const ratio = nextScale / oldScale;

    scale = nextScale;
    offset = {
      x: point.x - stageCenter.x - dx * ratio,
      y: point.y - stageCenter.y - dy * ratio
    };
    isFitView = false;
    renderViewport();
  }

  function getStagePoint(event) {
    const rect = refs.stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function renderViewport() {
    if (!refs.image) return;
    refs.image.style.transform = `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`;
    if (refs.zoomBadge) refs.zoomBadge.textContent = formatPercent(scale);
  }

  function setActiveIndex(index) {
    if (!state) return;
    const count = state.items.length;
    state.index = ((index % count) + count) % count;
    panSession = null;
    imageNaturalSize = null;
    isFitView = true;
    renderModalContent();
    preloadActiveImage();
  }

  function activeItem() {
    return state?.items[state.index] || null;
  }

  function preloadActiveImage() {
    const item = activeItem();
    if (!item) return;
    const requestId = ++preloadRequestId;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (requestId !== preloadRequestId) return;
      imageNaturalSize = {
        width: img.naturalWidth || item.naturalWidth || 1,
        height: img.naturalHeight || item.naturalHeight || 1
      };
      resetView();
      renderMetadata();
    };
    img.onerror = () => {
      if (requestId !== preloadRequestId) return;
      imageNaturalSize = null;
      resetView();
      renderMetadata("Image failed to load");
    };
    img.src = item.src;
  }

  function button(label, className, onClick, title = label) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className || "cim-button";
    el.textContent = label;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.addEventListener("click", onClick);
    return el;
  }

  function badge(text) {
    const el = document.createElement("span");
    el.className = "cim-badge";
    el.textContent = text;
    return el;
  }

  function renderModalShell() {
    console.info(LOG_PREFIX, "rendering modal shell", {
      itemCount: state?.items.length,
      index: state?.index,
      activeSrc: activeItem()?.src
    });
    removeModalDom();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "cim-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "cim-title");

    const dialog = document.createElement("div");
    dialog.className = "cim-dialog";

    const header = document.createElement("header");
    header.className = "cim-header";

    const titleBlock = document.createElement("div");
    titleBlock.className = "cim-title-block";
    const title = document.createElement("h2");
    title.id = "cim-title";
    const meta = document.createElement("div");
    meta.className = "cim-meta";
    titleBlock.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "cim-actions";

    const body = document.createElement("div");
    body.className = "cim-body";

    header.append(titleBlock, actions);
    dialog.append(header, body);
    root.append(dialog);
    document.documentElement.append(root);
    document.body.classList.add("cim-modal-open");

    refs = { root, dialog, header, title, meta, actions, body };
    renderModalContent();
    preloadActiveImage();

    root.addEventListener("click", (event) => {
      if (event.target === root) closeModal();
    });
    document.addEventListener("keydown", handleKeydown, true);
  }

  function renderMetadata(errorText) {
    const item = activeItem();
    if (!item || !refs.meta) return;
    refs.meta.textContent = "";
    refs.meta.append(
      badge(`${state.index + 1} / ${state.items.length}`),
      badge(getMimeType(item)),
      badge(formatDimensions(item)),
      badge(formatPercent(scale))
    );
    refs.zoomBadge = refs.meta.lastElementChild;
    if (errorText) refs.meta.append(badge(errorText));
  }

  function renderActions() {
    refs.actions.textContent = "";
    const saveControl = document.createElement("div");
    saveControl.className = "cim-save-control";

    const folderSelect = document.createElement("select");
    folderSelect.className = "cim-folder-select";
    folderSelect.setAttribute("aria-label", "Save folder");
    folderSelect.title = "Save folder";
    renderFolderOptions(folderSelect);
    if (selectedFolderId) folderSelect.value = selectedFolderId;
    folderSelect.addEventListener("change", () => {
      selectedFolderId = folderSelect.value;
      localStorage.setItem("cim-selected-folder-id", selectedFolderId);
    });

    const saveButton = button("Save", "cim-button", () => saveActiveImage(folderSelect.value), "Save image to folder");
    saveControl.append(folderSelect, saveButton);

    refs.actions.append(
      saveControl,
      button("Bulk Save", "cim-button", openBulkSavePane, "Bulk save page images"),
      button("Copy", "cim-button", copyActiveImage, "Copy image"),
      button("Download", "cim-button", downloadActiveImage, "Download image"),
      button("Zoom Out", "cim-button", () => zoomAt(ZOOM_OUT_FACTOR), "Zoom out"),
      button("Reset", "cim-button", resetView, "Reset zoom"),
      button("Zoom In", "cim-button", () => zoomAt(ZOOM_IN_FACTOR), "Zoom in"),
      button("Close", "cim-button cim-close-button", closeModal, "Close")
    );
    refreshFolders(folderSelect);
  }

  function renderFolderOptions(select) {
    select.textContent = "";
    if (!foldersCache.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Inbox";
      select.append(option);
      return;
    }
    for (const folder of foldersCache) {
      const option = document.createElement("option");
      option.value = folder.id;
      option.textContent = folder.name;
      select.append(option);
    }
  }

  async function refreshFolders(select) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "CIM_LIST_FOLDERS" });
      if (!response?.ok) throw new Error(response?.error || "Unable to load folders");
      foldersCache = response.folders || [];
      if (select?.isConnected) {
        const previous = selectedFolderId || select.value;
        renderFolderOptions(select);
        if (previous && foldersCache.some((folder) => folder.id === previous)) {
          select.value = previous;
        }
        selectedFolderId = select.value;
        localStorage.setItem("cim-selected-folder-id", selectedFolderId);
      }
    } catch (error) {
      console.warn(LOG_PREFIX, "folder load failed", error);
    }
  }

  function renderModalContent() {
    const item = activeItem();
    if (!item) return;

    refs.title.textContent = item.title || "Image";
    renderMetadata();
    renderActions();
    refs.body.textContent = "";

    if (state.items.length > 1) {
      const rail = document.createElement("aside");
      rail.className = "cim-rail";
      state.items.forEach((thumb, index) => {
        const thumbButton = document.createElement("button");
        thumbButton.type = "button";
        thumbButton.className = "cim-thumb";
        thumbButton.setAttribute("aria-label", `Open ${thumb.title || `image ${index + 1}`}`);
        if (index === state.index) thumbButton.setAttribute("aria-current", "true");
        thumbButton.addEventListener("click", () => setActiveIndex(index));

        const img = document.createElement("img");
        img.src = thumb.src;
        img.alt = thumb.alt || thumb.title || "";
        img.loading = "lazy";
        img.draggable = false;

        const number = document.createElement("span");
        number.className = "cim-thumb-number";
        number.textContent = String(index + 1);

        thumbButton.append(img, number);
        rail.append(thumbButton);
      });
      refs.body.append(rail);
    }

    const stageWrap = document.createElement("main");
    stageWrap.className = "cim-stage-wrap";

    const stage = document.createElement("div");
    stage.className = "cim-stage";
    stage.tabIndex = 0;
    stage.addEventListener("wheel", handleWheel, { passive: false });
    stage.addEventListener("dblclick", resetView);
    stage.addEventListener("pointerdown", handlePointerDown);
    stage.addEventListener("pointermove", handlePointerMove);
    stage.addEventListener("pointerup", handlePointerUp);
    stage.addEventListener("pointercancel", handlePointerUp);

    const img = document.createElement("img");
    img.className = "cim-main-image";
    img.src = item.src;
    img.alt = item.alt || item.title || "Selected image";
    img.draggable = false;
    img.addEventListener("load", () => {
      imageNaturalSize = {
        width: img.naturalWidth || item.naturalWidth || 1,
        height: img.naturalHeight || item.naturalHeight || 1
      };
      resetView();
      renderMetadata();
    });
    stage.append(img);

    if (state.items.length > 1) {
      stageWrap.append(
        button("Previous", "cim-nav cim-nav-prev", () => setActiveIndex(state.index - 1), "Previous image"),
        button("Next", "cim-nav cim-nav-next", () => setActiveIndex(state.index + 1), "Next image")
      );
    }

    stageWrap.append(stage);
    refs.body.append(stageWrap);
    refs.stage = stage;
    refs.image = img;

    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      stageSize = { width: box.width, height: box.height };
      if (isFitView) resetView();
    });
    resizeObserver.observe(stage);
    renderViewport();
  }

  function handleWheel(event) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(factor, getStagePoint(event));
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    refs.stage.setPointerCapture(event.pointerId);
    panSession = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY
    };
    refs.stage.classList.add("cim-panning");
  }

  function handlePointerMove(event) {
    if (!panSession || panSession.pointerId !== event.pointerId) return;
    const dx = event.clientX - panSession.lastX;
    const dy = event.clientY - panSession.lastY;
    panSession.lastX = event.clientX;
    panSession.lastY = event.clientY;
    offset = { x: offset.x + dx, y: offset.y + dy };
    isFitView = false;
    renderViewport();
  }

  function handlePointerUp(event) {
    if (!panSession || panSession.pointerId !== event.pointerId) return;
    try {
      refs.stage.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the page/browser.
    }
    panSession = null;
    refs.stage?.classList.remove("cim-panning");
  }

  function handleKeydown(event) {
    if (!state) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
    } else if (event.key === "ArrowLeft" && state.items.length > 1) {
      event.preventDefault();
      setActiveIndex(state.index - 1);
    } else if (event.key === "ArrowRight" && state.items.length > 1) {
      event.preventDefault();
      setActiveIndex(state.index + 1);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(ZOOM_IN_FACTOR);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAt(ZOOM_OUT_FACTOR);
    } else if (event.key === "0") {
      event.preventDefault();
      resetView();
    }
  }

  function handleGlobalShortcut(event) {
    if (event.key.toLowerCase() !== "p" || !event.shiftKey || !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (state) return;

    const img = findBestPageImage();
    console.info(LOG_PREFIX, "Cmd+Shift+P shortcut observed", {
      hasImage: Boolean(img),
      imageCount: document.images.length
    });
    if (img) openModalForImage(img);
  }

  async function fetchImageBlob(item) {
    if (item.src.startsWith("data:")) {
      const response = await fetch(item.src);
      return response.blob();
    }

    const response = await chrome.runtime.sendMessage({
      type: "CIM_FETCH_IMAGE",
      url: item.src
    });
    if (!response?.ok) throw new Error(response?.error || "Unable to fetch image");
    return new Blob([new Uint8Array(response.bytes)], { type: response.type || "image/png" });
  }

  async function copyActiveImage() {
    const item = activeItem();
    if (!item) return;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Image clipboard writing is not supported in this browser.");
      }
      const blob = await fetchImageBlob(item);
      const type = blob.type || "image/png";
      if (ClipboardItem.supports && !ClipboardItem.supports(type)) {
        throw new Error(`Clipboard does not support ${type}.`);
      }
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      showToast("Image copied");
    } catch (error) {
      showToast(error.message || "Unable to copy image", true);
    }
  }

  async function downloadActiveImage() {
    const item = activeItem();
    if (!item) return;
    try {
      const filename = getFileName(item);
      if (item.src.startsWith("data:")) {
        const blob = await fetchImageBlob(item);
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.rel = "noopener";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } else {
        const response = await chrome.runtime.sendMessage({
          type: "CIM_DOWNLOAD_IMAGE",
          url: item.src,
          filename
        });
        if (!response?.ok) throw new Error(response?.error || "Unable to download image");
      }
      showToast("Download started");
    } catch (error) {
      showToast(error.message || "Unable to download image", true);
    }
  }

  async function saveActiveImage(folderId) {
    const item = activeItem();
    if (!item) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CIM_SAVE_IMAGE",
        src: item.src,
        title: item.title || getFileName(item),
        pageUrl: location.href,
        folderId: folderId || null
      });
      if (!response?.ok) throw new Error(response?.error || "Unable to save image");
      showToast(response.duplicate ? `Already saved in ${response.folder?.name || "folder"}` : `Saved to ${response.folder?.name || "folder"}`);
      await refreshFolders();
    } catch (error) {
      showToast(error.message || "Unable to save image", true);
    }
  }

  function openBulkSavePane() {
    const items = state?.items?.length ? state.items : collectImages(activeItem()?.src || "").images;
    const selected = new Set(items.map((item) => item.src));

    const overlay = document.createElement("div");
    overlay.className = "cim-bulk-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Bulk save images");

    const panel = document.createElement("div");
    panel.className = "cim-bulk-panel";

    const header = document.createElement("header");
    header.className = "cim-bulk-header";
    const title = document.createElement("h3");
    title.textContent = "Bulk Save Images";

    const folderSelect = document.createElement("select");
    folderSelect.className = "cim-folder-select";
    renderFolderOptions(folderSelect);
    if (selectedFolderId) folderSelect.value = selectedFolderId;
    folderSelect.addEventListener("change", () => {
      selectedFolderId = folderSelect.value;
      localStorage.setItem("cim-selected-folder-id", selectedFolderId);
    });

    const allButton = button("All", "cim-button", () => {
      for (const item of items) selected.add(item.src);
      renderBulkGrid(grid, items, selected);
      updateCount();
    });
    const noneButton = button("None", "cim-button", () => {
      selected.clear();
      renderBulkGrid(grid, items, selected);
      updateCount();
    });
    const count = document.createElement("span");
    count.className = "cim-bulk-count";
    const saveButton = button("Save Selected", "cim-button", async () => {
      await saveSelectedImages(items, selected, folderSelect.value);
      overlay.remove();
    });
    const downloadButton = button("Download Selected", "cim-button", async () => {
      await downloadSelectedImages(items, selected);
    });
    const closeButton = button("Close", "cim-button", () => overlay.remove());

    const controls = document.createElement("div");
    controls.className = "cim-bulk-controls";
    controls.append(folderSelect, allButton, noneButton, count, saveButton, downloadButton, closeButton);
    header.append(title, controls);

    const grid = document.createElement("div");
    grid.className = "cim-bulk-grid";
    function updateCount() {
      count.textContent = `${selected.size} selected`;
    }
    renderBulkGrid(grid, items, selected, updateCount);
    updateCount();

    panel.append(header, grid);
    overlay.append(panel);
    refs.root.append(overlay);
    refreshFolders(folderSelect);
  }

  function renderBulkGrid(grid, items, selected, onChange = () => {}) {
    grid.textContent = "";
    for (const item of items) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "cim-bulk-tile";
      tile.setAttribute("aria-pressed", String(selected.has(item.src)));
      tile.title = item.title || "Image";
      tile.addEventListener("click", () => {
        if (selected.has(item.src)) selected.delete(item.src);
        else selected.add(item.src);
        tile.setAttribute("aria-pressed", String(selected.has(item.src)));
        onChange();
      });

      const img = document.createElement("img");
      img.src = item.src;
      img.alt = item.alt || item.title || "";
      img.loading = "lazy";
      tile.append(img);
      grid.append(tile);
    }
  }

  async function saveSelectedImages(items, selected, folderId) {
    const images = items
      .filter((item) => selected.has(item.src))
      .map((item) => ({ src: item.src, title: item.title, pageUrl: location.href }));
    if (!images.length) {
      showToast("No images selected", true);
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "CIM_SAVE_IMAGES",
        images,
        folderId: folderId || null,
        pageUrl: location.href
      });
      if (!response?.ok) throw new Error(response?.error || "Unable to save images");
      showToast(`Saved ${response.saved}; skipped ${response.duplicates} duplicate${response.duplicates === 1 ? "" : "s"}`);
      await refreshFolders();
    } catch (error) {
      showToast(error.message || "Unable to save selected images", true);
    }
  }

  async function downloadSelectedImages(items, selected) {
    const images = items.filter((item) => selected.has(item.src));
    if (!images.length) {
      showToast("No images selected", true);
      return;
    }

    try {
      const files = [];
      for (let index = 0; index < images.length; index += 1) {
        const item = images[index];
        const blob = await fetchImageBlob(item);
        files.push({
          name: uniqueDownloadName(files, getFileName(item), blob.type, index),
          blob
        });
      }

      if (files.length === 1) {
        triggerBlobDownload(files[0].blob, files[0].name);
      } else {
        const zip = await createZipBlob(files);
        triggerBlobDownload(zip, `page-images-${new Date().toISOString().slice(0, 10)}.zip`);
      }
      showToast("Download started");
    } catch (error) {
      showToast(error.message || "Unable to download selected images", true);
    }
  }

  function triggerBlobDownload(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  function uniqueDownloadName(existingFiles, baseName, type, index) {
    const extension = extensionForType(type);
    let clean = sanitizeFilename(baseName || `image-${index + 1}`);
    if (!/\.[a-z0-9]{2,5}$/i.test(clean) && extension) clean += extension;
    const used = new Set(existingFiles.map((file) => file.name));
    if (!used.has(clean)) return clean;
    const dot = clean.lastIndexOf(".");
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : "";
    let counter = 2;
    while (used.has(`${stem}-${counter}${ext}`)) counter += 1;
    return `${stem}-${counter}${ext}`;
  }

  function sanitizeFilename(name) {
    return String(name || "image")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "image";
  }

  function extensionForType(type) {
    if (type === "image/jpeg") return ".jpg";
    if (type === "image/png") return ".png";
    if (type === "image/gif") return ".gif";
    if (type === "image/webp") return ".webp";
    if (type === "image/svg+xml") return ".svg";
    return "";
  }

  async function createZipBlob(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const centralDirectory = [];
    let offset = 0;

    for (const file of files) {
      const data = new Uint8Array(await file.blob.arrayBuffer());
      const nameBytes = encoder.encode(file.name);
      const crc = crc32(data);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(localHeader.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);
      chunks.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, 0, true);
      centralView.setUint16(14, 0, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralDirectory.push(centralHeader);
      offset += localHeader.length + data.length;
    }

    const centralStart = offset;
    const centralSize = centralDirectory.reduce((total, chunk) => total + chunk.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralStart, true);
    return new Blob([...chunks, ...centralDirectory, end], { type: "application/zip" });
  }

  function crc32(data) {
    let crc = -1;
    for (let i = 0; i < data.length; i += 1) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
    return table;
  })();

  function showToast(message, isError = false) {
    if (!refs.root) return;
    const toast = document.createElement("div");
    toast.className = `cim-toast${isError ? " cim-toast-error" : ""}`;
    toast.textContent = message;
    refs.root.append(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function openModalForImage(img) {
    const activeSrc = getBestImageSrc(img);
    console.info(LOG_PREFIX, "open image element request", {
      activeSrc,
      alt: img.getAttribute("alt"),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight
    });
    if (!activeSrc) {
      console.warn(LOG_PREFIX, "image element had no usable src", img);
      return;
    }
    const { images, activeIndex } = collectImages(activeSrc);
    state = {
      items: images.length ? images : [{
        src: activeSrc,
        title: getAltOrName(img, activeSrc, 0),
        alt: img.alt || ""
      }],
      index: activeIndex
    };
    renderModalShell();
  }

  function openModalForImageUrl(srcUrl) {
    const activeSrc = normalizeUrl(srcUrl);
    console.info(LOG_PREFIX, "open image URL request", { srcUrl, activeSrc });
    if (!activeSrc) {
      console.warn(LOG_PREFIX, "context menu request had no usable srcUrl", srcUrl);
      return false;
    }

    const matchingImage = Array.from(document.images).find((img) => sourcesMatch(getBestImageSrc(img), activeSrc));
    if (matchingImage) {
      openModalForImage(matchingImage);
      return true;
    }

    const { images } = collectImages(activeSrc);
    state = {
      items: [{
        src: activeSrc,
        title: getAltOrName({ getAttribute: () => "", alt: "" }, activeSrc, 0),
        alt: ""
      }, ...images.filter((item) => !sourcesMatch(item.src, activeSrc))],
      index: 0
    };
    renderModalShell();
    return true;
  }

  function closeModal() {
    removeModalDom();
    refs = {};
    state = null;
    imageNaturalSize = null;
    stageSize = null;
    scale = 1;
    offset = { x: 0, y: 0 };
    panSession = null;
  }

  function removeModalDom() {
    const existing = document.getElementById(ROOT_ID);
    if (existing) existing.remove();
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    document.body?.classList.remove("cim-modal-open");
    document.removeEventListener("keydown", handleKeydown, true);
  }

  function markHoverableImages() {
    for (const img of document.images) {
      img.dataset.cimHoverable = "true";
    }
  }

  function handleAltImageActivation(event, trigger) {
    if (!event.altKey) return false;
    const img = event.target?.closest?.("img");
    console.info(LOG_PREFIX, `Alt-${trigger} observed`, {
      targetTag: event.target?.tagName,
      hasImageTarget: Boolean(img),
      button: event.button,
      defaultPrevented: event.defaultPrevented,
      x: event.clientX,
      y: event.clientY
    });
    if (!img) return false;

    const now = Date.now();
    if (now - lastAltOpenAt < 400) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    }
    lastAltOpenAt = now;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openModalForImage(img);
    return true;
  }

  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    handleAltImageActivation(event, "pointerdown");
  }, true);

  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    handleAltImageActivation(event, "mousedown");
  }, true);

  document.addEventListener("click", (event) => {
    handleAltImageActivation(event, "click");
  }, true);

  document.addEventListener("keydown", handleGlobalShortcut, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.info(LOG_PREFIX, "content message", message?.type, message);
    if (message?.type === "CIM_OPEN_IMAGE_URL") {
      const opened = openModalForImageUrl(message.srcUrl);
      sendResponse({
        ok: opened,
        imageCount: document.images.length,
        url: location.href
      });
      return true;
    }
    return false;
  });

  installPageStyle();
  markHoverableImages();

  const imageMarker = new MutationObserver(() => markHoverableImages());
  imageMarker.observe(document.documentElement, { childList: true, subtree: true });
})();
