
let eventLogs = [];
let historyLogs = [];

// ---------- Load Event Logs ----------

async function loadEventLogs() {
    try {
        const response = await fetch("/api/logs/events");

        if (!response.ok) {
            throw new Error("Failed to load event logs");
        }

        eventLogs = await response.json();
        filterEventLogs();

        console.log("Event logs loaded:", eventLogs);

    } catch (error) {
        console.error("Event log error:", error);
    }
}

// ---------- Load History Logs ----------

async function loadHistoryLogs() {
    try {
        const response = await fetch("/api/logs/history");

        if (!response.ok) {
            throw new Error("Failed to load history");
        }

        historyLogs = await response.json();
        filterHistoryLogs();

        console.log("History loaded:", historyLogs);

    } catch (error) {
        console.error("History error:", error);
    }
}

// ---------- Badge Styling ----------

function badgeClass(level) {
    if (level === "critical") return "badge critical";
    if (level === "warning") return "badge warning";
    if (level === "info") return "badge info";
    if (level === "error") return "badge error";

    return "badge";
}

// ---------- Render Event Logs ----------

function renderEventLogs(items) {
    const body = document.getElementById("eventLogBody");
    body.replaceChildren();

    items.forEach(log => {
        const row = document.createElement("tr");

        const time = document.createElement("td");
        time.textContent = log.time;

        const severityCell = document.createElement("td");
        const severityBadge = document.createElement("span");
        severityBadge.className = badgeClass(log.severity);
        severityBadge.textContent = log.severity;
        severityCell.appendChild(severityBadge);

        const device = document.createElement("td");
        device.textContent = log.device;

        const message = document.createElement("td");
        message.textContent = log.message;

        const duration = document.createElement("td");
        duration.textContent = log.duration;

        row.append(time, severityCell, device, message, duration);
        body.appendChild(row);
    });

    document.getElementById("activeAlertCount").textContent = items.length;
}

// ---------- Render History Logs ----------

function renderHistoryLogs(items) {
    const body = document.getElementById("historyLogBody");
    body.replaceChildren();

    items.forEach(log => {
        const row = document.createElement("tr");

        const timestamp = document.createElement("td");
        timestamp.textContent = log.timestamp;

        const severityCell = document.createElement("td");
        const severityBadge = document.createElement("span");
        severityBadge.className = badgeClass(log.severity);
        severityBadge.textContent = log.severity;
        severityCell.appendChild(severityBadge);

        const source = document.createElement("td");
        source.textContent = log.source;

        const action = document.createElement("td");
        action.textContent = log.action;

        const user = document.createElement("td");
        user.textContent = log.user;

        const description = document.createElement("td");
        description.textContent = log.description;

        row.append(
            timestamp,
            severityCell,
            source,
            action,
            user,
            description
        );

        body.appendChild(row);
    });
}

// ---------- Filter Event Logs ----------

function filterEventLogs() {
    const search = document
        .getElementById("eventSearch")
        .value.toLowerCase();

    const severity = document.getElementById("severityFilter").value;

    const filtered = eventLogs.filter(log => {
        const matchesSearch =
            String(log.device ?? "").toLowerCase().includes(search) ||
            String(log.message ?? "").toLowerCase().includes(search);

        const matchesSeverity =
            severity === "all" || log.severity === severity;

        return matchesSearch && matchesSeverity;
    });

    renderEventLogs(filtered);
}

// ---------- Filter History Logs ----------

function filterHistoryLogs() {
    const search = document
        .getElementById("historySearch")
        .value.toLowerCase();

    const type = document.getElementById("logTypeFilter").value;

    const filtered = historyLogs.filter(log => {
        const matchesSearch =
            String(log.source ?? "").toLowerCase().includes(search) ||
            String(log.description ?? "").toLowerCase().includes(search) ||
            String(log.action ?? "").toLowerCase().includes(search);

        const matchesType =
            type === "all" ||
            String(log.action ?? "").toLowerCase().includes(type);

        return matchesSearch && matchesType;
    });

    renderHistoryLogs(filtered);
}

// ---------- Refresh Button ----------

document.getElementById("refreshLogs")
    .addEventListener("click", async () => {
        await Promise.all([
            loadEventLogs(),
            loadHistoryLogs()
        ]);
    });

// ---------- Search and Filter Events ----------

document.getElementById("eventSearch")
    .addEventListener("input", filterEventLogs);

document.getElementById("severityFilter")
    .addEventListener("change", filterEventLogs);

document.getElementById("historySearch")
    .addEventListener("input", filterHistoryLogs);

document.getElementById("logTypeFilter")
    .addEventListener("change", filterHistoryLogs);

// ---------- Socket.IO Live Updates ----------

if (typeof io !== "undefined") {
    const socket = io();

    socket.on("connect", () => {
        console.log("Logs page connected to live updates");
    });

    socket.on("networkUpdate", async (data) => {
        console.log("Logs page received a live network update:", data);

        // Reload the logs after each network scan update
        await Promise.all([
            loadEventLogs(),
            loadHistoryLogs()
        ]);
    });

    socket.on("disconnect", () => {
        console.log("Logs page disconnected from live updates");
    });

} else {
    console.error("Socket.IO client not loaded. Check logs.html.");
}

// ---------- Initial Load ----------

loadEventLogs();
loadHistoryLogs();
