import { createServer } from "node:net";
export function parsePortReservations(records) {
    const parsed = [];
    for (const record of records) {
        let metadata;
        try {
            metadata = JSON.parse(record.metadataJson);
        }
        catch {
            continue;
        }
        if (!isPortReservationMetadata(metadata))
            continue;
        parsed.push({
            id: record.id,
            project: metadata.project,
            service: metadata.service,
            hostPort: metadata.hostPort,
            containerPort: metadata.containerPort,
            protocol: "tcp",
        });
    }
    return parsed;
}
export async function planPorts(input, checker = isTcpPortAvailable) {
    const reservedByPort = new Map();
    for (const reservation of input.reservations) {
        const key = reservationKey(reservation.project, reservation.service, reservation.protocol);
        if (!reservedByPort.has(reservation.hostPort)) {
            reservedByPort.set(reservation.hostPort, new Set());
        }
        reservedByPort.get(reservation.hostPort)?.add(key);
    }
    const occupied = new Set();
    const planUsed = new Set();
    const checked = new Map();
    const assignments = [];
    for (const service of input.services) {
        const serviceKey = reservationKey(input.project, service.name, "tcp");
        const preferred = Number.isInteger(service.preferredHostPort) ? Number(service.preferredHostPort) : undefined;
        const candidate = await pickCandidatePort({
            preferredHostPort: preferred,
            rangeStart: input.rangeStart,
            rangeEnd: input.rangeEnd,
            serviceKey,
            reservedByPort,
            occupied,
            planUsed,
            checked,
            checker,
        });
        if (candidate === null) {
            throw new Error(`No available host port for service '${service.name}' in range ${input.rangeStart}-${input.rangeEnd}.`);
        }
        planUsed.add(candidate);
        occupied.add(candidate);
        assignments.push({
            project: input.project,
            service: service.name,
            hostPort: candidate,
            containerPort: service.containerPort,
            protocol: "tcp",
        });
    }
    return assignments;
}
export function reservationKey(project, service, protocol) {
    return `${project}\u0000${service}\u0000${protocol}`;
}
export async function isTcpPortAvailable(port) {
    if (!isValidPort(port))
        return false;
    return new Promise((resolve) => {
        const server = createServer();
        const finish = (result) => {
            server.removeAllListeners();
            server.close(() => resolve(result));
        };
        server.once("error", () => finish(false));
        server.once("listening", () => finish(true));
        server.listen({ host: "0.0.0.0", port, exclusive: true });
    });
}
function isPortReservationMetadata(value) {
    if (!value || typeof value !== "object")
        return false;
    const data = value;
    return data.type === "port-reservation"
        && typeof data.project === "string"
        && typeof data.service === "string"
        && Number.isInteger(data.hostPort)
        && Number.isInteger(data.containerPort)
        && (data.protocol === undefined || data.protocol === "tcp");
}
async function pickCandidatePort(input) {
    const candidates = [];
    if (input.preferredHostPort !== undefined) {
        candidates.push(input.preferredHostPort);
    }
    for (let port = input.rangeStart; port <= input.rangeEnd; port += 1) {
        if (port === input.preferredHostPort)
            continue;
        candidates.push(port);
    }
    for (const port of candidates) {
        if (!isValidPort(port))
            continue;
        if (input.planUsed.has(port) || input.occupied.has(port))
            continue;
        const owners = input.reservedByPort.get(port);
        if (owners && (owners.size > 1 || !owners.has(input.serviceKey))) {
            continue;
        }
        let free = input.checked.get(port);
        if (free === undefined) {
            free = await input.checker(port);
            input.checked.set(port, free);
        }
        if (!free) {
            input.occupied.add(port);
            continue;
        }
        return port;
    }
    return null;
}
function isValidPort(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}
