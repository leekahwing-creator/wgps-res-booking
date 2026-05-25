const fs = require("fs");
const path = require("path");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");

const testBookingDate = "2026-06-01";
const bookingsFile = ensureMonthlyBookingsFile(testBookingDate);

const testBookingsXML = `<?xml version="1.0" encoding="UTF-8"?>
<bookings>
  <booking id="1">
    <name>Test User A</name>
    <bookingDate>2026-06-01</bookingDate>
    <startTime>09:00</startTime>
    <endTime>10:00</endTime>
    <location>1A</location>
    <deviceType>iPad</deviceType>
    <softwareRequirement>None</softwareRequirement>
    <devicesRequired>40</devicesRequired>
    <status>Confirmed</status>
    <allocation>
      <allocationMethod>Direct Allocation</allocationMethod>
      <cartCount>1</cartCount>
      <bagCount>0</bagCount>
      <totalAllocatedCapacity>40</totalAllocatedCapacity>
      <resources>
        <resourceId>IPAD-CART-05</resourceId>
      </resources>
    </allocation>
    <submittedAt>2026-05-25T01:00:00.000Z</submittedAt>
  </booking>

  <booking id="2">
    <name>Test User B</name>
    <bookingDate>2026-06-01</bookingDate>
    <startTime>09:00</startTime>
    <endTime>10:00</endTime>
    <location>1B</location>
    <deviceType>iPad</deviceType>
    <softwareRequirement>None</softwareRequirement>
    <devicesRequired>40</devicesRequired>
    <status>Confirmed</status>
    <allocation>
      <allocationMethod>Direct Allocation</allocationMethod>
      <cartCount>1</cartCount>
      <bagCount>0</bagCount>
      <totalAllocatedCapacity>40</totalAllocatedCapacity>
      <resources>
        <resourceId>IPAD-CART-06</resourceId>
      </resources>
    </allocation>
    <submittedAt>2026-05-25T01:05:00.000Z</submittedAt>
  </booking>

  <booking id="3">
    <name>Test User C</name>
    <bookingDate>2026-06-01</bookingDate>
    <startTime>09:00</startTime>
    <endTime>10:00</endTime>
    <location>1C</location>
    <deviceType>iPad</deviceType>
    <softwareRequirement>None</softwareRequirement>
    <devicesRequired>40</devicesRequired>
    <status>Confirmed</status>
    <allocation>
      <allocationMethod>Direct Allocation</allocationMethod>
      <cartCount>1</cartCount>
      <bagCount>0</bagCount>
      <totalAllocatedCapacity>40</totalAllocatedCapacity>
      <resources>
        <resourceId>IPAD-CART-07</resourceId>
      </resources>
    </allocation>
    <submittedAt>2026-05-25T01:10:00.000Z</submittedAt>
  </booking>

  <booking id="4">
    <name>Test User D</name>
    <bookingDate>2026-06-01</bookingDate>
    <startTime>09:00</startTime>
    <endTime>10:00</endTime>
    <location>1D</location>
    <deviceType>iPad</deviceType>
    <softwareRequirement>None</softwareRequirement>
    <devicesRequired>24</devicesRequired>
    <status>Confirmed</status>
    <allocation>
      <allocationMethod>Direct Allocation</allocationMethod>
      <cartCount>1</cartCount>
      <bagCount>0</bagCount>
      <totalAllocatedCapacity>40</totalAllocatedCapacity>
      <resources>
        <resourceId>IPAD-CART-10</resourceId>
      </resources>
    </allocation>
    <submittedAt>2026-05-25T01:15:00.000Z</submittedAt>
  </booking>

  <booking id="5">
    <name>Test User E</name>
    <bookingDate>2026-06-01</bookingDate>
    <startTime>09:00</startTime>
    <endTime>10:00</endTime>
    <location>1E</location>
    <deviceType>iPad</deviceType>
    <softwareRequirement>None</softwareRequirement>
    <devicesRequired>35</devicesRequired>
    <status>Confirmed</status>
    <allocation>
      <allocationMethod>Direct Allocation</allocationMethod>
      <cartCount>1</cartCount>
      <bagCount>0</bagCount>
      <totalAllocatedCapacity>35</totalAllocatedCapacity>
      <resources>
        <resourceId>IPAD-CART-08</resourceId>
      </resources>
    </allocation>
    <submittedAt>2026-05-25T01:20:00.000Z</submittedAt>
  </booking>
</bookings>`;

fs.writeFileSync(bookingsFile, testBookingsXML);

console.log(`Conflict test bookings written to ${bookingsFile}`);
