const params = new URLSearchParams(location.search);
const requestedFolderId = params.get("folderId") || "";
const requestedImageId = params.get("imageId") || "";
const app = document.getElementById("app");

const state = {
  folders: [],
  images: [],
  objectUrls: [],
  folderId: requestedFolderId,
  index: 0,
  scale: 1,
  offset: { x: 0, y: 0 },
  naturalSize: null,
  stageSize: null,
  isFitView: true,
  pan: null
};

load();
document.addEventListener("keydown", handleKeydown, true);

async function load() {
  const response = await chrome.runtime.sendMessage({ type: "CIM_LIST_LIBRARY" });
  if (!response?.ok) {
    renderEmpty(response?.error || "Unable to load image folder");
    return;
  }

  state.folders = response.folders || [];
  state.images = (response.images || []).map((image) => {
    const blob = new Blob([new Uint8Array(image.bytes)], { type: image.type || "image/png" });
    const objectUrl = URL.createObjectURL(blob);
    state.objectUrls.push(objectUrl);
    return { ...image, objectUrl };
  });

  if (!state.folderId || !state.folders.some((folder) => folder.id === state.folderId)) {
    state.folderId = state.folders[0]?.id || "";
  }

  const images = folderImages();
  state.index = Math.max(0, images.findIndex((image) => image.id === requestedImageId));
  if (!images.length) {
    renderEmpty("No images saved in this folder.");
    return;
  }
  render();
}

function folderImages() {
  return state.images.filter((image) => image.folderId === state.folderId);
}

function activeImage() {
  return folderImages()[state.index] || null;
}

function render() {
  const images = folderImages();
  const image = activeImage();
  if (!image) {
    renderEmpty("Image not found.");
    return;
  }

  app.textContent = "";
  const shell = document.createElement("div");
  shell.className = "viewer-shell";

  const header = document.createElement("header");
  header.className = "viewer-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "viewer-title";
  const title = document.createElement("h1");
  title.textContent = image.title || "Image";
  const meta = document.createElement("div");
  meta.className = "viewer-meta";
  titleWrap.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "viewer-actions";
  actions.append(
    button("Download All", downloadAll),
    button("Zoom Out", () => zoom(0.8)),
    button("Reset", reset),
    button("Zoom In", () => zoom(1.25)),
    button("Close", () => window.close())
  );
  header.append(titleWrap, actions);

  const body = document.createElement("div");
  body.className = "viewer-body";

  const rail = document.createElement("aside");
  rail.className = "viewer-rail";
  images.forEach((thumb, index) => {
    const thumbButton = document.createElement("button");
    thumbButton.type = "button";
    thumbButton.className = "viewer-thumb";
    thumbButton.setAttribute("aria-current", String(index === state.index));
    thumbButton.addEventListener("click", () => setIndex(index));
    const img = document.createElement("img");
    img.src = thumb.objectUrl;
    img.alt = thumb.title || "";
    thumbButton.append(img);
    rail.append(thumbButton);
  });

  const stageWrap = document.createElement("main");
  stageWrap.className = "viewer-stage-wrap";
  if (images.length > 1) {
    stageWrap.append(
      navButton("Previous", () => setIndex(state.index - 1), "viewer-nav viewer-prev"),
      navButton("Next", () => setIndex(state.index + 1), "viewer-nav viewer-next")
    );
  }

  const stage = document.createElement("div");
  stage.className = "viewer-stage";
  stage.tabIndex = 0;
  const img = document.createElement("img");
  img.className = "viewer-image";
  img.src = image.objectUrl;
  img.alt = image.title || "Selected image";
  img.draggable = false;
  img.addEventListener("load", () => {
    state.naturalSize = {
      width: img.naturalWidth || 1,
      height: img.naturalHeight || 1
    };
    reset();
  });

  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom(Math.exp(-event.deltaY * 0.0015), stagePoint(event));
  }, { passive: false });
  stage.addEventListener("dblclick", reset);
  stage.addEventListener("pointerdown", startPan);
  stage.addEventListener("pointermove", movePan);
  stage.addEventListener("pointerup", endPan);
  stage.addEventListener("pointercancel", endPan);

  stage.append(img);
  stageWrap.append(stage);
  body.append(rail, stageWrap);
  shell.append(header, body);
  app.append(shell);

  state.stage = stage;
  state.imageEl = img;
  state.metaEl = meta;
  new ResizeObserver(([entry]) => {
    state.stageSize = {
      width: entry.contentRect.width,
      height: entry.contentRect.height
    };
    if (state.isFitView) reset();
  }).observe(stage);
  renderTransform();
}

function button(text, onClick) {
  return navButton(text, onClick, "viewer-button");
}

function navButton(text, onClick, className) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = text;
  el.addEventListener("click", onClick);
  return el;
}

function setIndex(index) {
  const images = folderImages();
  state.index = ((index % images.length) + images.length) % images.length;
  state.scale = 1;
  state.offset = { x: 0, y: 0 };
  state.naturalSize = null;
  state.isFitView = true;
  state.pan = null;
  render();
}

function fitScale() {
  if (!state.stageSize || !state.naturalSize) return 1;
  return Math.min(
    1,
    state.stageSize.width / state.naturalSize.width,
    state.stageSize.height / state.naturalSize.height,
    8
  );
}

function reset() {
  state.scale = fitScale();
  state.offset = { x: 0, y: 0 };
  state.isFitView = true;
  renderTransform();
}

function zoom(factor, anchor) {
  if (!state.stageSize) return;
  const oldScale = state.scale;
  const nextScale = Math.min(8, Math.max(Math.min(0.2, fitScale()), oldScale * factor));
  if (nextScale === oldScale) return;

  const center = { x: state.stageSize.width / 2, y: state.stageSize.height / 2 };
  const point = anchor || center;
  const dx = point.x - center.x - state.offset.x;
  const dy = point.y - center.y - state.offset.y;
  const ratio = nextScale / oldScale;
  state.scale = nextScale;
  state.offset = {
    x: point.x - center.x - dx * ratio,
    y: point.y - center.y - dy * ratio
  };
  state.isFitView = false;
  renderTransform();
}

function renderTransform() {
  if (!state.imageEl) return;
  state.imageEl.style.transform = `translate(calc(-50% + ${state.offset.x}px), calc(-50% + ${state.offset.y}px)) scale(${state.scale})`;
  const images = folderImages();
  if (state.metaEl) {
    state.metaEl.textContent = `${state.index + 1} / ${images.length} · ${Math.round(state.scale * 100)}%`;
  }
}

function stagePoint(event) {
  const rect = state.stage.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function startPan(event) {
  if (event.button !== 0) return;
  state.stage.setPointerCapture(event.pointerId);
  state.pan = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY
  };
  state.stage.classList.add("panning");
}

function movePan(event) {
  if (!state.pan || state.pan.pointerId !== event.pointerId) return;
  state.offset.x += event.clientX - state.pan.lastX;
  state.offset.y += event.clientY - state.pan.lastY;
  state.pan.lastX = event.clientX;
  state.pan.lastY = event.clientY;
  state.isFitView = false;
  renderTransform();
}

function endPan(event) {
  if (!state.pan || state.pan.pointerId !== event.pointerId) return;
  try {
    state.stage.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture may already be released.
  }
  state.pan = null;
  state.stage.classList.remove("panning");
}

function handleKeydown(event) {
  const images = folderImages();
  if (!images.length) return;

  if (event.key === "ArrowLeft" && images.length > 1) {
    event.preventDefault();
    setIndex(state.index - 1);
  } else if (event.key === "ArrowRight" && images.length > 1) {
    event.preventDefault();
    setIndex(state.index + 1);
  } else if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoom(1.25);
  } else if (event.key === "-") {
    event.preventDefault();
    zoom(0.8);
  } else if (event.key === "0") {
    event.preventDefault();
    reset();
  } else if (event.key === "Escape") {
    event.preventDefault();
    window.close();
  }
}

function renderEmpty(text) {
  app.textContent = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = text;
  app.append(empty);
}

async function downloadAll() {
  const images = folderImages();
  if (!images.length) return;

  const files = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    files.push({
      name: uniqueDownloadName(files, image.title || image.src, image.type, index),
      blob: new Blob([new Uint8Array(image.bytes)], { type: image.type || "image/png" })
    });
  }

  if (files.length === 1) {
    triggerBlobDownload(files[0].blob, files[0].name);
    return;
  }

  const folder = state.folders.find((item) => item.id === state.folderId);
  const zip = await createZipBlob(files);
  triggerBlobDownload(zip, `${sanitizeFilename(folder?.name || "image-folder")}.zip`);
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
