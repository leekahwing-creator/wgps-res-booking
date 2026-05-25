const fs = require("fs");
const path = require("path");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const bookingsDir = path.join(dataDir, "bookings");

function getBookingMonth(bookingDate) {
  return bookingDate.slice(0, 7); // YYYY-MM
}

function getMonthlyBookingsFile(bookingDate) {
  const month = getBookingMonth(bookingDate);

  if (!fs.existsSync(bookingsDir)) {
    fs.mkdirSync(bookingsDir, { recursive: true });
  }

  return path.join(bookingsDir, `${month}.xml`);
}

function ensureMonthlyBookingsFile(bookingDate) {
  const monthlyFile = getMonthlyBookingsFile(bookingDate);

  if (!fs.existsSync(monthlyFile)) {
    fs.writeFileSync(
      monthlyFile,
      `<?xml version="1.0" encoding="UTF-8"?>\n<bookings></bookings>`
    );
  }

  return monthlyFile;
}

module.exports = {
  getMonthlyBookingsFile,
  ensureMonthlyBookingsFile
};
