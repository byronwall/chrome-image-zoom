# Alt Image Zoom Modal

Unpacked Chrome extension for inspecting, saving, and organizing images from any webpage.

## Screenshots

### Page Image Zoom Modal

![](docs/screenshots/modal.png)

### Bulk Save Grid

![](docs/screenshots/bulk-save.png)

### Folder Viewer

![](docs/screenshots/folder-viewer.png)

## Core Features

- Alt-click any page image to open the zoom modal.
- Press `Cmd+Shift+P` anywhere on a page to open the modal for the best available image.
- Page images and videos are collected into a thumbnail carousel.
- Fit-to-stage viewing, wheel zoom, button zoom, double-click reset, and drag panning.
- Previous/next navigation with buttons, thumbnails, and keyboard arrows.
- Grid view for quick image selection.
- Jump back to the active page image from the zoom modal.
- Copy and download the active image.
- Bulk-select page images in a 100px thumbnail grid.
- Save images into extension-owned folders backed by IndexedDB.
- De-dupe saved images within the same folder by SHA-256 content hash.
- Open saved folders in a full-tab zoom viewer.
- Download selected page images or entire folders as a ZIP when there is more than one image.

## Shortcuts

- `Alt` + click image: open the clicked image in the zoom modal.
- `Cmd+Shift+P`: open the zoom modal from anywhere on the page.
- `ArrowLeft` / `ArrowRight`: previous/next image.
- `+` or `=`: zoom in.
- `-`: zoom out.
- `0`: reset zoom.
- `g`: toggle the modal image grid.
- `j`: close the modal and jump to the active page image.
- `Escape`: close the active viewer where supported.

## Image Folders

- Click the extension toolbar icon to open the folder browser.
- Create and delete folders from the popup.
- Use the modal's folder picker and **Save** button to save the active image.
- Use **Bulk Save** to select multiple page images and save or download them.
- Right-click an image and choose **Save image to Inbox** for a fast default save.
- Click **Open** on a saved image to launch the full-tab folder viewer.
- In the folder viewer, **Download All** downloads one image directly or creates a ZIP for multiple images.

## Install As Unpacked Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `/Users/byronwall/Projects/chrome-image-modal`.

After editing extension files, click **Reload** for the extension in `chrome://extensions`, then refresh any webpage where the content script should run.

## Implementation Notes

- `chrome.storage` is used for extension permissions and IndexedDB is used for image bytes and folder data.
- Stored image bytes remain available after leaving the original page.
- The extension uses no build step and no external dependencies.
- Some sites may still restrict image fetching. Viewing can work even when copy, save, or download fail because those actions require fetching the image bytes.
