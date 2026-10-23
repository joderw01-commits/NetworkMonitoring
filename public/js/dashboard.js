
let devices = [];
let deviceChart = null;
let availabilityChart = null;

async function loadDevices() {
    try {
        const response = await fetch("/api/devices");

        if (!response.ok) {
            throw new Error("Failed to fetch devices");
        }

        devices = await response.json();

        createDeviceChart();
        updateDashboard();
        displayProblemDevices();

        console.log("Devices loaded:", devices);

    } catch (error) {
        console.error("Error loading devices:", error);
    }
}

function updateDashboard() {
    const total = devices.length;

    const online = devices.filter(device => device.status === "online").length;
    const offline = devices.filter(device => device.status === "offline").length;
    const warning = devices.filter(device => device.status === "warning").length;

    const health = total === 0 ? 0 : (online / total) * 100;

    document.getElementById("healthPercent").textContent =
        health.toFixed(1) + "%";

    document.getElementById("healthNote").textContent =
        online + " healthy devices";

    // Demo traffic values
    document.getElementById("totalTraffic").textContent = 452;
    document.getElementById("trafficChange").textContent = "↑ 180 ↓ 272";

    document.getElementById("criticalAlerts").textContent =
        offline + " Critical";

    document.getElementById("warningAlerts").textContent =
        warning + " Warnings";

    document.getElementById("monitoredTotal").textContent = total;
    document.getElementById("monitoredUp").textContent = online;
    document.getElementById("monitoredDown").textContent = offline;
}

function createDeviceChart() {
    const deviceTypes = {};

    devices.forEach(device => {
        const type = device.type;
        deviceTypes[type] = (deviceTypes[type] || 0) + 1;
    });

    const labels = Object.keys(deviceTypes);
    const counts = Object.values(deviceTypes);
    const ctx = document.getElementById("deviceChart");

    if (deviceChart) {
        deviceChart.destroy();
    }

    deviceChart = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: labels,
            datasets: [{
                data: counts,
                backgroundColor: [
                    "#2563eb",
                    "#16a34a",
                    "#f59e0b",
                    "#8b5cf6",
                    "#06b6d4",
                    "#ec4899",
                    "#64748b",
                    "#14b8a6"
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: "bottom"
                }
            }
        }
    });
}

async function createAvailabilityChart() {
    try {
        const response = await fetch("/api/availability?hours=24");

        if (!response.ok) {
            throw new Error("Failed to load availability data");
        }

        const history = await response.json();

        const times = history.map(record =>
            new Date(record.ts).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit"
            })
        );

        const availability = history.map(record =>
            record.availability
        );

        const canvas = document.getElementById("availabilityChart");

        if (availabilityChart) {
            availabilityChart.destroy();
        }

        availabilityChart = new Chart(canvas, {
            type: "line",
            data: {
                labels: times,
                datasets: [{
                    label: "Network Availability (%)",
                    data: availability,
                    borderColor: "#2563eb",
                    backgroundColor: "rgba(37,99,235,0.1)",
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        min: 0,
                        max: 100,
                        ticks: {
                            callback: value => value + "%"
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    }
                }
            }
        });

        console.log("Availability history loaded:", history);

    } catch (error) {
        console.error("Error loading availability:", error);
    }
}

async function displayRecentActivity() {
    const container = document.getElementById("recentActivity");

    try {
        const response = await fetch("/api/activity");

        if (!response.ok) {
            throw new Error("Failed to fetch activity");
        }

        const activities = await response.json();

        container.replaceChildren();

        if (activities.length === 0) {
            container.textContent = "No recent network events.";
            return;
        }

        activities.forEach(activity => {
            const item = document.createElement("div");
            item.className = "timeline-item";

            const icon = document.createElement("div");
            icon.className = `timeline-icon ${activity.type}`;
            icon.textContent = activity.icon;

            const content = document.createElement("div");
            content.className = "timeline-content";

            const title = document.createElement("strong");
            title.textContent = activity.title;

            const description = document.createElement("p");
            description.textContent = activity.description;

            const time = document.createElement("small");
            time.textContent = activity.time;

            content.append(title, description, time);
            item.append(icon, content);
            container.appendChild(item);
        });

    } catch (error) {
        console.error("Error loading activity:", error);
        container.textContent = "Unable to load recent activity.";
    }
}

function displayProblemDevices() {
    const container = document.getElementById("problemDevices");

    container.replaceChildren();

    const problemDevices = devices.filter(device =>
        device.status === "offline" ||
        device.status === "warning"
    );

    if (problemDevices.length === 0) {
        container.textContent = "All devices are operating normally.";
        return;
    }

    problemDevices.forEach(device => {
        const item = document.createElement("div");
        item.className = "problem-item " + device.status;

        const name = document.createElement("strong");
        name.textContent = device.name;

        const info = document.createElement("span");
        info.textContent = device.ip;

        const status = document.createElement("span");
        status.className = "device-status " + device.status;
        status.textContent = device.status.toUpperCase();

        item.append(name, info, status);
        container.appendChild(item);
    });
}

// Connect to the Socket.IO server
if (typeof io !== "undefined") {
    const socket = io();

    socket.on("connect", () => {
        console.log("Connected to live network updates");
    });

    socket.on("networkUpdate", data => {
        if (data.devices) {
            devices = data.devices;

            updateDashboard();
            createDeviceChart();
            displayProblemDevices();
        }

        if (data.activity) {
            displayRecentActivity();
        }

        console.log("Live network update received:", data);
    });

    socket.on("disconnect", () => {
        console.log("Disconnected from live updates");
    });

} else {
    console.error("Socket.IO client not loaded. Check index.html.");
}

// Initial page load
loadDevices();
createAvailabilityChart();
displayRecentActivity();
