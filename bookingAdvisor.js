
(function () {
  "use strict";

  function escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function buildReadinessItems(context) {
    const advice = context.advice || null;
    const progress = context.progress || {};
    const items = [
      { label: "Device selected", ready: Boolean(progress.device && context.deviceType) },
      { label: "Quantity confirmed", ready: Boolean(progress.quantity && Number(context.devicesRequired || 0) > 0) },
      { label: "Resources and add-ons reviewed", ready: Boolean(progress.resourcesReviewed) },
      { label: "Booking date selected", ready: Boolean(progress.date) },
      { label: "Valid time selected", ready: Boolean(progress.time && context.timingReady) },
      { label: "Deployment location confirmed", ready: Boolean(progress.location && context.locationReady) },
      {
        label: advice ? "Availability outlook complete" : "Availability outlook pending",
        ready: Boolean(advice)
      }
    ];

    return {
      items,
      completeCount: items.filter(item => item.ready).length,
      totalCount: items.length,
      formReady: items.slice(0, 6).every(item => item.ready),
      fullyReady: items.every(item => item.ready)
    };
  }

  function renderReadinessChecklist(readiness) {
    const percentage = readiness.totalCount
      ? Math.round((readiness.completeCount / readiness.totalCount) * 100)
      : 0;
    const nextIncomplete = readiness.items.find(item => !item.ready);
    const nextText = readiness.fullyReady
      ? "Ready to submit"
      : (nextIncomplete ? `Next: ${nextIncomplete.label}` : "Review before submitting");

    return `
      <section class="booking-progress" aria-label="Booking progress">
        <div class="booking-progress-header">
          <strong>Booking progress</strong>
          <span class="booking-progress-count">${readiness.completeCount}/${readiness.totalCount} complete</span>
        </div>
        <div class="booking-progress-track" aria-hidden="true">
          <div class="booking-progress-fill" style="width:${percentage}%"></div>
        </div>
        <div class="booking-progress-next">${escapeHTML(nextText)}</div>
        <details>
          <summary>View progress details</summary>
          <div class="booking-progress-list">
            ${readiness.items.map(item => `
              <div class="booking-progress-item ${item.ready ? "complete" : ""}">
                <span aria-hidden="true">${item.ready ? "✓" : "○"}</span>
                <span>${escapeHTML(item.label)}</span>
              </div>
            `).join("")}
          </div>
        </details>
      </section>
    `;
  }

  function buildFulfilmentExplanation(advice, location) {
    if (!advice) {
      return {
        title: "Fulfilment pending",
        message: "Complete the timing fields to receive an operational fulfilment estimate."
      };
    }

    const resources = Array.isArray(advice.likelyDeviceResources)
      ? advice.likelyDeviceResources
      : [];
    const resourceNames = resources
      .map(resource => String(resource.name || "").trim())
      .filter(Boolean);
    const resourceText = resourceNames.length
      ? resourceNames.join(", ")
      : "the final allocated resource";

    if (advice.fulfilmentMode === "Collection") {
      return {
        title: "Collection expected",
        message: `The request is likely to use ${resourceText}. Collect the resource from the ICT Work Room before the lesson and return it after use.`
      };
    }

    if (advice.fulfilmentMode === "Mixed") {
      return {
        title: "Mixed fulfilment expected",
        message: `The likely allocation (${resourceText}) combines deployment and collection resources. Follow the final confirmation instructions for each allocated resource.`
      };
    }

    if (advice.fulfilmentMode === "Deployment") {
      return {
        title: "Deployment expected",
        message: `The request is likely to use ${resourceText}. The Deployment Team is expected to deliver it to ${location || "the selected deployment location"}.`
      };
    }

    return {
      title: "Fulfilment not yet determined",
      message: "The final fulfilment mode will be confirmed after resource allocation."
    };
  }

  function buildTimelineModel(advice, selectedStart, selectedEnd) {
    if (!selectedStart || !selectedEnd) return [];

    const selectedLevel = advice?.conflictHeat === "High"
      ? "high"
      : (advice?.conflictHeat === "Moderate" ? "moderate" : "low");

    const entries = [{
      label: `${selectedStart}–${selectedEnd}`,
      level: selectedLevel,
      note: advice?.conflictHeat === "High" ? "High demand" : (advice?.conflictHeat === "Moderate" ? "Moderate demand" : "Low demand")
    }];

    const alternatives = advice?.structuredRecommendations?.alternativeTimes || [];
    alternatives.slice(0, 3).forEach(item => {
      entries.push({
        label: `${item.startTime}–${item.endTime}`,
        level: item.confidence === "High" ? "low" : "moderate",
        note: item.confidence === "High" ? "Lower-demand option" : "Alternative time"
      });
    });

    return entries;
  }

  function renderTimelinePreview(model) {
    if (!model.length) {
      return `
        <section class="timeline-preview" aria-label="Resource demand timeline">
          <div class="timeline-heading"><strong>How busy is this time slot?</strong></div>
          <div class="timeline-empty">Select a valid time period to see how busy ICT resources are based on existing bookings.</div>
        </section>
      `;
    }

    return `
      <section class="timeline-preview" aria-label="Resource demand timeline">
        <div class="timeline-heading">
          <strong>How busy is this time slot?</strong>
          <span>Based on existing bookings</span>
        </div>
        <div class="timeline-explainer">The bar estimates ICT resource demand from existing bookings. Longer bars indicate a busier period.</div>
        <div class="timeline-bars">
          ${model.map(item => `
            <div class="timeline-row">
              <span class="timeline-label">${escapeHTML(item.label)}</span>
              <span class="timeline-track">
                <span class="timeline-fill ${item.level}" style="width:${
                  item.level === "high" ? 92 : item.level === "moderate" ? 62 : 34
                }%"></span>
              </span>
              <span class="timeline-note">${escapeHTML(item.note)}</span>
            </div>
          `).join("")}
        </div>
        <div class="timeline-legend" aria-label="Demand legend">
          <span><i class="timeline-dot low"></i>Low demand</span>
          <span><i class="timeline-dot moderate"></i>Moderate demand</span>
          <span><i class="timeline-dot high"></i>High demand</span>
        </div>
      </section>
    `;
  }

  function renderBookingConfirmation(confirmation) {
    const resources = Array.isArray(confirmation.resources)
      ? confirmation.resources.filter(Boolean)
      : [];
    const resourceText = resources.length
      ? resources.join(", ")
      : "Allocation details available in My Bookings";

    const fulfilmentText = confirmation.fulfilmentMode === "Collection"
      ? "Collection from ICT Work Room"
      : (confirmation.location
        ? `${confirmation.fulfilmentMode} to ${confirmation.location}`
        : confirmation.fulfilmentMode);

    return `
      <section class="booking-confirmation-panel" aria-label="Booking confirmation">
        <div class="booking-confirmation-heading">
          <span class="booking-confirmation-icon" aria-hidden="true">✓</span>
          <span>${escapeHTML(confirmation.title || "Booking confirmed")}</span>
        </div>
        <div class="booking-confirmation-grid">
          <div class="booking-confirmation-row">
            <span>Allocated resources</span>
            <strong>${escapeHTML(resourceText)}</strong>
          </div>
          <div class="booking-confirmation-row">
            <span>Allocated capacity</span>
            <strong>${Number(confirmation.capacity || 0)} devices</strong>
          </div>
          <div class="booking-confirmation-row">
            <span>Fulfilment</span>
            <strong>${escapeHTML(fulfilmentText || "Confirmed")}</strong>
          </div>
          <div class="booking-confirmation-row">
            <span>Allocation method</span>
            <strong>${escapeHTML(confirmation.allocationMethod || "Automatic Allocation")}</strong>
          </div>
        </div>
        <div class="booking-confirmation-actions">
          <a href="manage-bookings.html">View My Bookings</a>
          <button type="button" data-create-another-booking>Create another booking</button>
        </div>
      </section>
    `;
  }

  window.BookingAdvisor = Object.freeze({
    escapeHTML,
    buildReadinessItems,
    renderReadinessChecklist,
    buildFulfilmentExplanation,
    buildTimelineModel,
    renderTimelinePreview,
    renderBookingConfirmation
  });
})();
