function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function paginateArray(list, options) {
  const arr = Array.isArray(list) ? list : [];
  const pageRaw = options && options.page !== undefined ? options.page : 1;
  const pageSizeRaw = options && options.pageSize !== undefined ? options.pageSize : 20;
  const maxPageSizeRaw = options && options.maxPageSize !== undefined ? options.maxPageSize : 5000;

  const maxPageSize = Math.max(1, toInt(maxPageSizeRaw, 5000));
  const page = Math.max(1, toInt(pageRaw, 1));
  const pageSize = Math.max(0, Math.min(toInt(pageSizeRaw, 20), maxPageSize));
  const total = arr.length;

  if (!pageSize) {
    return { page: 1, pageSize: 0, total, items: arr };
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, pageCount));
  const start = (safePage - 1) * pageSize;
  return { page: safePage, pageSize, total, items: arr.slice(start, start + pageSize) };
}

module.exports = { paginateArray };
