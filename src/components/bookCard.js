/**
 * READER App — Book Card Component
 * Creates beautiful book card elements for the library grid
 */

/**
 * Creates a book card DOM element
 * @param {Object} book - Book data from IndexedDB
 * @param {string} book.id - Book ID
 * @param {string} book.title - Book title
 * @param {string} book.thumbnail - Base64 thumbnail data URL
 * @param {number} book.pageCount - Number of pages
 * @param {number} book.addedAt - Timestamp when added
 * @param {number} book.lastOpenedAt - Timestamp when last opened
 * @param {number} book.fileSize - File size in bytes
 * @param {Function} onOpen - Callback when card is clicked
 * @param {Function} onContextMenu - Callback for right-click
 * @returns {HTMLElement}
 */
export function createBookCard(book, onOpen, onContextMenu) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.dataset.bookId = book.id;
  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open ${book.title}`);

  const timeAgo = getTimeAgo(book.lastOpenedAt || book.addedAt);
  const fileSize = formatFileSize(book.fileSize);

  card.innerHTML = `
    <div class="book-thumbnail">
      <img src="${book.thumbnail}" alt="${book.title}" loading="lazy" />
      <div class="book-overlay">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
        <span>Read</span>
      </div>
    </div>
    <div class="book-card__body">
      <h3 class="book-card__title" title="${book.title}">${book.title}</h3>
      <div class="book-card__meta">
        <span>${book.pageCount} pages</span>
        <span class="book-card__meta-dot"></span>
        <span>${fileSize}</span>
      </div>
      <div class="book-card__meta" style="margin-top: 2px;">${timeAgo}</div>
    </div>
  `;

  // Click to open
  card.addEventListener('click', (e) => {
    e.preventDefault();
    onOpen(book.id);
  });

  // Keyboard support
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(book.id);
    }
  });

  // Right-click context menu
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    onContextMenu(e, book);
  });

  return card;
}

/**
 * Format bytes to human-readable size
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

/**
 * Get relative time string
 * @param {number} timestamp
 * @returns {string}
 */
function getTimeAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
