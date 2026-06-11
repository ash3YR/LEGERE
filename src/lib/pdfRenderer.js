/**
 * PDF Rendering Module for READER
 *
 * Handles loading, rendering, and thumbnail generation for PDF documents
 * using PDF.js (pdfjs-dist). Supports HiDPI/Retina displays for sharp
 * rendering at all device pixel ratios.
 *
 * @module pdfRenderer
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerURL from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Initialize the PDF.js worker at module level
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerURL;

/**
 * Load a PDF document from a URL, ArrayBuffer, or Uint8Array.
 *
 * @param {string | ArrayBuffer | Uint8Array} source - The PDF source.
 *   Can be a URL string, an ArrayBuffer, or a Uint8Array of PDF data.
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>} The loaded PDF document proxy.
 * @throws {Error} If the source is invalid or the PDF cannot be loaded.
 *
 * @example
 * const pdf = await loadPDF('/documents/sample.pdf');
 * console.log(`Loaded PDF with ${pdf.numPages} pages`);
 */
export async function loadPDF(source) {
  if (!source) {
    throw new Error('PDF source is required. Provide a URL string, ArrayBuffer, or Uint8Array.');
  }

  // Build the loading task parameters based on source type
  let loadingParams;

  if (typeof source === 'string') {
    loadingParams = { url: source };
  } else if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    // PDF.js accepts typed arrays and ArrayBuffers via the `data` parameter
    loadingParams = { data: source };
  } else {
    throw new Error(
      `Invalid PDF source type: ${typeof source}. Expected a URL string, ArrayBuffer, or Uint8Array.`
    );
  }

  try {
    const loadingTask = pdfjsLib.getDocument(loadingParams);
    const pdf = await loadingTask.promise;
    return pdf;
  } catch (error) {
    throw new Error(`Failed to load PDF: ${error.message}`);
  }
}

/**
 * Render a single page of a PDF document onto a canvas element.
 * Handles HiDPI/Retina displays by scaling the canvas backing store
 * while keeping CSS dimensions at logical pixel sizes.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdf - The loaded PDF document proxy.
 * @param {number} pageNumber - The 1-based page number to render.
 * @param {HTMLCanvasElement} canvas - The canvas element to render onto.
 * @param {number} [scale=1.5] - The zoom scale factor for the viewport.
 * @returns {Promise<{ width: number, height: number }>} The rendered page
 *   dimensions in CSS pixels (not physical device pixels).
 * @throws {Error} If the page number is out of range or rendering fails.
 *
 * @example
 * const canvas = document.getElementById('pdf-canvas');
 * const { width, height } = await renderPage(pdf, 1, canvas, 2.0);
 */
export async function renderPage(pdf, pageNumber, canvas, scale = 1.5) {
  if (!pdf || typeof pdf.getPage !== 'function') {
    throw new Error('Invalid PDF document proxy. Load a PDF first using loadPDF().');
  }

  if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
    throw new Error('A valid HTMLCanvasElement is required for rendering.');
  }

  const totalPages = pdf.numPages;
  if (pageNumber < 1 || pageNumber > totalPages) {
    throw new Error(
      `Page number ${pageNumber} is out of range. The document has ${totalPages} page(s).`
    );
  }

  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    // HiDPI / Retina support
    const outputScale = window.devicePixelRatio || 1;

    // Set the physical (backing store) canvas size
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);

    // Set the CSS display size to logical pixels
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const context = canvas.getContext('2d');

    // Apply a transform so PDF.js renders at the higher physical resolution
    const renderContext = {
      canvasContext: context,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    };

    const renderTask = page.render(renderContext);
    await renderTask.promise;

    return {
      width: Math.floor(viewport.width),
      height: Math.floor(viewport.height),
    };
  } catch (error) {
    throw new Error(`Failed to render page ${pageNumber}: ${error.message}`);
  }
}

/**
 * Generate a JPEG thumbnail of the first page of a PDF document.
 * Uses a temporary offscreen canvas and scales the page to fit within
 * the specified maximum width.
 *
 * @param {string | ArrayBuffer | Uint8Array} source - The PDF source
 *   (URL string, ArrayBuffer, or Uint8Array).
 * @param {number} [maxWidth=200] - The maximum width of the thumbnail in pixels.
 * @returns {Promise<{ thumbnail: string, pageCount: number }>} An object
 *   containing the base64-encoded JPEG data URL and the total page count.
 * @throws {Error} If the PDF cannot be loaded or the thumbnail cannot be generated.
 *
 * @example
 * const { thumbnail, pageCount } = await generateThumbnail(pdfArrayBuffer, 150);
 * imgElement.src = thumbnail;
 */
export async function generateThumbnail(source, maxWidth = 200) {
  let pdf;
  try {
    pdf = await loadPDF(source);
  } catch (error) {
    throw new Error(`Failed to generate thumbnail: ${error.message}`);
  }

  try {
    const page = await pdf.getPage(1);
    const pageCount = pdf.numPages;

    // Get the page's natural viewport (scale = 1) to compute aspect ratio
    const unscaledViewport = page.getViewport({ scale: 1 });

    // Calculate the scale needed to fit within maxWidth
    const scale = maxWidth / unscaledViewport.width;
    const viewport = page.getViewport({ scale });

    // Create a temporary offscreen canvas for thumbnail rendering
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = Math.floor(viewport.width);
    offscreenCanvas.height = Math.floor(viewport.height);

    const context = offscreenCanvas.getContext('2d');

    const renderTask = page.render({
      canvasContext: context,
      viewport,
    });
    await renderTask.promise;

    // Encode the canvas as a JPEG data URL at 70% quality
    const thumbnail = offscreenCanvas.toDataURL('image/jpeg', 0.7);

    return { thumbnail, pageCount };
  } catch (error) {
    throw new Error(`Failed to generate thumbnail: ${error.message}`);
  }
}

/**
 * Get the total number of pages in a loaded PDF document.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdf - The loaded PDF document proxy.
 * @returns {number} The total number of pages.
 * @throws {Error} If the provided object is not a valid PDF document proxy.
 *
 * @example
 * const pdf = await loadPDF('/documents/report.pdf');
 * const total = getPageCount(pdf);
 * console.log(`Document has ${total} pages`);
 */
export function getPageCount(pdf) {
  if (!pdf || typeof pdf.numPages !== 'number') {
    throw new Error('Invalid PDF document proxy. Load a PDF first using loadPDF().');
  }
  return pdf.numPages;
}

// Re-export pdfjsLib for advanced usage (e.g. custom rendering pipelines)
export { pdfjsLib };
