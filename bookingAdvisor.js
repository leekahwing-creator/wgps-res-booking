
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
    const items = [
      { label: "Device selected", ready: Boolean(context.deviceType) },
      { label: "Quantity specified", ready: Number(context.devicesRequired || 0) > 0 },
      { label: "Accessory selection compatible", ready: Boolean(context.accessoriesCompatible) },
      { label: "Software requirement supported", ready: Boolean(context.softwareSupported) },
      { label: "Valid date and time selected", ready: Boolean(context.timingReady) },
      { label: "Deployment location confirmed", ready: Boolean(context.locationReady) },
      {
        label: advice ? "Resources likely available" : "Availability outlook completed",
        ready: Boolean(advice && advice.directFulfilmentLikely)
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
    const stateText = readiness.fullyReady
      ? "Ready to book"
      : (readiness.formReady
        ? "Review the availability advice before submitting"
        : "Complete the remaining steps");

    return `
      <section class="readiness-panel ${readiness.fullyReady ? "ready" : ""}" aria-label="Booking readiness">
        <div class="readiness-heading">
          <strong>Booking readiness</strong>
          <span>${readiness.completeCount}/${readiness.totalCount} checks</span>
        </div>
        <div class="readiness-list">
          ${readiness.items.map(item => `
            <div class="readiness-item ${item.ready ? "complete" : ""}">
              <span class="readiness-icon" aria-hidden="true">${item.ready ? "✓" : "○"}</span>
              <span>${escapeHTML(item.label)}</span>
            </div>
          `).join("")}
        </div>
        <div class="readiness-state">${escapeHTML(stateText)}</div>
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
      note: "Selected period"
    }];

    const alternatives = advice?.structuredRecommendations?.alternativeTimes || [];
    alternatives.slice(0, 3).forEach(item => {
      entries.push({
        label: `${item.startTime}–${item.endTime}`,
        level: item.confidence === "High" ? "low" : "moderate",
        note: "Suggested alternative"
      });
    });

    return entries;
  }

  function renderTimelinePreview(model) {
    if (!model.length) {
      return `
        <section class="timeline-preview" aria-label="Resource demand timeline">
          <div class="timeline-heading"><strong>Resource timeline</strong></div>
          <div class="timeline-empty">Select a valid time period to preview relative demand.</div>
        </section>
      `;
    }

    return `
      <section class="timeline-preview" aria-label="Resource demand timeline">
        <div class="timeline-heading">
          <strong>Resource timeline</strong>
          <span>Advisory demand view</span>
        </div>
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
      </section>
    `;
  }

  window.BookingAdvisor = Object.freeze({
    escapeHTML,
    buildReadinessItems,
    renderReadinessChecklist,
    buildFulfilmentExplanation,
    buildTimelineModel,
    renderTimelinePreview
  });
})();
