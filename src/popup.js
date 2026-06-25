const state = {
  folders: [],
  images: [],
  activeFolderId: null,
  objectUrls: [],
  viewer: null
};

const foldersEl = document.getElementById("folders");
const imagesEl = document.getElementById("images");
const statusEl = document.getElementById("status");
const folderTitleEl = document.getElementById("folder-title");
const folderCountEl = document.getElementById("folder-count");
const folderForm = document.getElementById("folder-form");
const folderNameInput = document.getElementById("folder-name");
const refreshButton = document.getElementById("refresh");
const createTestPageButton = document.getElementById("create-test-page");

folderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = folderNameInput.value.trim();
  if (!name) return;
  setStatus("Creating folder");
  const response = await chrome.runtime.sendMessage({ type: "CIM_CREATE_FOLDER", name });
  if (!response?.ok) {
    setStatus(response?.error || "Unable to create folder");
    return;
  }
  folderNameInput.value = "";
  state.activeFolderId = response.folder.id;
  await loadLibrary();
});

refreshButton.addEventListener("click", () => loadLibrary());

createTestPageButton.addEventListener("click", async () => {
  setStatus("Opening test page");
  const response = await chrome.runtime.sendMessage({ type: "CIM_OPEN_TEST_PAGE" });
  if (!response?.ok) {
    setStatus(response?.error || "Unable to open test page");
    return;
  }
  setStatus("Test page opened");
  window.close();
});

loadLibrary();

async function loadLibrary() {
  setStatus("Loading");
  cleanupObjectUrls();
  const response = await chrome.runtime.sendMessage({ type: "CIM_LIST_LIBRARY" });
  if (!response?.ok) {
    setStatus(response?.error || "Unable to load library");
    return;
  }

  state.folders = response.folders || [];
  state.images = (response.images || []).map((image) => {
    const blob = new Blob([new Uint8Array(image.bytes)], { type: image.type || "image/png" });
    const objectUrl = URL.createObjectURL(blob);
    state.objectUrls.push(objectUrl);
    return { ...image, objectUrl };
  });

  if (!state.activeFolderId || !state.folders.some((folder) => folder.id === state.activeFolderId)) {
    state.activeFolderId = state.folders[0]?.id || null;
  }

  render();
  setStatus(`${state.images.length} saved image${state.images.length === 1 ? "" : "s"}`);
}

function render() {
  renderFolders();
  renderImages();
}

function renderFolders() {
  foldersEl.textContent = "";
  for (const folder of state.folders) {
    const row = document.createElement("div");
    row.className = "folder-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder";
    button.setAttribute("aria-current", String(folder.id === state.activeFolderId));
    button.addEventListener("click", () => {
      state.activeFolderId = folder.id;
      render();
    });

    const name = document.createElement("span");
    name.textContent = folder.name;
    const count = document.createElement("span");
    count.className = "folder-count";
    count.textContent = String(folder.count || 0);
    button.append(name, count);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "folder-delete";
    del.textContent = "Delete";
    del.disabled = state.folders.length <= 1;
    del.addEventListener("click", async () => {
      const ok = confirm(`Delete "${folder.name}" and ${folder.count || 0} saved image${folder.count === 1 ? "" : "s"}?`);
      if (!ok) return;
      setStatus("Deleting folder");
      const response = await chrome.runtime.sendMessage({
        type: "CIM_DELETE_FOLDER",
        folderId: folder.id
      });
      if (!response?.ok) {
        setStatus(response?.error || "Unable to delete folder");
        return;
      }
      state.activeFolderId = null;
      await loadLibrary();
    });

    row.append(button, del);
    foldersEl.append(row);
  }
}

function renderImages() {
  imagesEl.textContent = "";
  const folder = state.folders.find((item) => item.id === state.activeFolderId);
  const images = state.images.filter((image) => image.folderId === state.activeFolderId);

  folderTitleEl.textContent = folder?.name || "Folder";
  folderCountEl.textContent = `${images.length} image${images.length === 1 ? "" : "s"}`;

  if (!images.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No images saved in this folder.";
    imagesEl.append(empty);
    return;
  }

  for (const image of images) {
    imagesEl.append(renderImageCard(image));
  }
}

function renderImageCard(image) {
  const card = document.createElement("article");
  card.className = "image-card";

  const img = document.createElement("img");
  img.src = image.objectUrl;
  img.alt = image.title || "Saved image";
  img.loading = "lazy";

  const meta = document.createElement("div");
  meta.className = "image-meta";

  const title = document.createElement("div");
  title.className = "image-title";
  title.textContent = image.title || "Image";

  const source = document.createElement("div");
  source.className = "image-source";
  source.textContent = image.pageUrl || image.src;
  source.title = image.pageUrl || image.src;

  const actions = document.createElement("div");
  actions.className = "image-actions";

  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open";
  open.addEventListener("click", () => openFolderViewer(image.id));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    setStatus("Deleting");
    const response = await chrome.runtime.sendMessage({
      type: "CIM_DELETE_STORED_IMAGE",
      imageId: image.id
    });
    if (!response?.ok) {
      setStatus(response?.error || "Unable to delete image");
      return;
    }
    await loadLibrary();
  });

  actions.append(open, del);
  meta.append(title, source, actions);
  card.append(img, meta);
  return card;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function cleanupObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
}

function openFolderViewer(activeImageId) {
  const url = chrome.runtime.getURL(
    `src/viewer.html?folderId=${encodeURIComponent(state.activeFolderId || "")}&imageId=${encodeURIComponent(activeImageId)}`
  );
  chrome.tabs.create({ url });
}

function closeViewer() {
  document.querySelector(".viewer-overlay")?.remove();
  state.viewer = null;
}

function renderViewer() {
  document.querySelector(".viewer-overlay")?.remove();
  const viewer = state.viewer;
  if (!viewer) return;
  const image = viewer.images[viewer.index];

  const overlay = document.createElement("div");
  overlay.className = "viewer-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Folder image viewer");

  const shell = document.createElement("div");
  shell.className = "viewer-shell";

  const header = document.createElement("header");
  header.className = "viewer-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "viewer-title";
  const title = document.createElement("h3");
  title.textContent = image.title || "Image";
  const meta = document.createElement("div");
  meta.className = "viewer-meta";
  meta.textContent = `${viewer.index + 1} / ${viewer.images.length}`;
  titleWrap.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "viewer-actions";
  actions.append(
    viewerButton("Zoom Out", () => zoomViewer(0.8)),
    viewerButton("Reset", resetViewer),
    viewerButton("Zoom In", () => zoomViewer(1.25)),
    viewerButton("Close", closeViewer)
  );
  header.append(titleWrap, actions);

  const body = document.createElement("div");
  body.className = "viewer-body";

  const rail = document.createElement("aside");
  rail.className = "viewer-rail";
  viewer.images.forEach((thumb, thumbIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "viewer-thumb";
    button.setAttribute("aria-current", String(thumbIndex === viewer.index));
    button.addEventListener("click", () => setViewerIndex(thumbIndex));

    const img = document.createElement("img");
    img.src = thumb.objectUrl;
    img.alt = thumb.title || "";
    button.append(img);
    rail.append(button);
  });

  const stageWrap = document.createElement("main");
  stageWrap.className = "viewer-stage-wrap";
  if (viewer.images.length > 1) {
    stageWrap.append(
      viewerButton("Previous", () => setViewerIndex(viewer.index - 1), "viewer-nav viewer-prev"),
      viewerButton("Next", () => setViewerIndex(viewer.index + 1), "viewer-nav viewer-next")
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
    viewer.naturalSize = {
      width: img.naturalWidth || 1,
      height: img.naturalHeight || 1
    };
    resetViewer();
  });

  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomViewer(Math.exp(-event.deltaY * 0.0015), getViewerStagePoint(event));
  }, { passive: false });
  stage.addEventListener("dblclick", resetViewer);
  stage.addEventListener("pointerdown", startViewerPan);
  stage.addEventListener("pointermove", moveViewerPan);
  stage.addEventListener("pointerup", endViewerPan);
  stage.addEventListener("pointercancel", endViewerPan);

  stage.append(img);
  stageWrap.append(stage);
  body.append(rail, stageWrap);
  shell.append(header, body);
  overlay.append(shell);
  document.body.append(overlay);

  viewer.stage = stage;
  viewer.imageEl = img;
  viewer.zoomMeta = meta;
  new ResizeObserver(([entry]) => {
    viewer.stageSize = {
      width: entry.contentRect.width,
      height: entry.contentRect.height
    };
    if (viewer.isFitView) resetViewer();
  }).observe(stage);
  renderViewerTransform();
}

function viewerButton(text, onClick, className = "viewer-button") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function setViewerIndex(index) {
  const viewer = state.viewer;
  if (!viewer) return;
  const count = viewer.images.length;
  viewer.index = ((index % count) + count) % count;
  viewer.scale = 1;
  viewer.offset = { x: 0, y: 0 };
  viewer.naturalSize = null;
  viewer.isFitView = true;
  viewer.pan = null;
  renderViewer();
}

function viewerFitScale() {
  const viewer = state.viewer;
  if (!viewer?.stageSize || !viewer.naturalSize) return 1;
  return Math.min(
    1,
    viewer.stageSize.width / viewer.naturalSize.width,
    viewer.stageSize.height / viewer.naturalSize.height,
    8
  );
}

function resetViewer() {
  const viewer = state.viewer;
  if (!viewer) return;
  viewer.scale = viewerFitScale();
  viewer.offset = { x: 0, y: 0 };
  viewer.isFitView = true;
  renderViewerTransform();
}

function zoomViewer(factor, anchor) {
  const viewer = state.viewer;
  if (!viewer?.stageSize) return;
  const oldScale = viewer.scale;
  const fit = viewerFitScale();
  const minScale = Math.min(0.2, fit);
  const nextScale = Math.min(8, Math.max(minScale, oldScale * factor));
  if (nextScale === oldScale) return;

  const center = { x: viewer.stageSize.width / 2, y: viewer.stageSize.height / 2 };
  const point = anchor || center;
  const dx = point.x - center.x - viewer.offset.x;
  const dy = point.y - center.y - viewer.offset.y;
  const ratio = nextScale / oldScale;

  viewer.scale = nextScale;
  viewer.offset = {
    x: point.x - center.x - dx * ratio,
    y: point.y - center.y - dy * ratio
  };
  viewer.isFitView = false;
  renderViewerTransform();
}

function renderViewerTransform() {
  const viewer = state.viewer;
  if (!viewer?.imageEl) return;
  viewer.imageEl.style.transform = `translate(calc(-50% + ${viewer.offset.x}px), calc(-50% + ${viewer.offset.y}px)) scale(${viewer.scale})`;
  if (viewer.zoomMeta) {
    viewer.zoomMeta.textContent = `${viewer.index + 1} / ${viewer.images.length} · ${Math.round(viewer.scale * 100)}%`;
  }
}

function getViewerStagePoint(event) {
  const rect = state.viewer.stage.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function startViewerPan(event) {
  const viewer = state.viewer;
  if (!viewer || event.button !== 0) return;
  viewer.stage.setPointerCapture(event.pointerId);
  viewer.pan = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY
  };
  viewer.stage.classList.add("panning");
}

function moveViewerPan(event) {
  const viewer = state.viewer;
  if (!viewer?.pan || viewer.pan.pointerId !== event.pointerId) return;
  viewer.offset.x += event.clientX - viewer.pan.lastX;
  viewer.offset.y += event.clientY - viewer.pan.lastY;
  viewer.pan.lastX = event.clientX;
  viewer.pan.lastY = event.clientY;
  viewer.isFitView = false;
  renderViewerTransform();
}

function endViewerPan(event) {
  const viewer = state.viewer;
  if (!viewer?.pan || viewer.pan.pointerId !== event.pointerId) return;
  try {
    viewer.stage.releasePointerCapture(event.pointerId);
  } catch {
    // Already released.
  }
  viewer.pan = null;
  viewer.stage.classList.remove("panning");
}
