import type { MemoryRecord } from "./types.js";
export interface PortServiceRequest {
    name: string;
    containerPort: number;
    preferredHostPort?: number;
}
export interface PortReservation {
    id: string;
    project: string;
    service: string;
    hostPort: number;
    containerPort: number;
    protocol: "tcp";
}
export interface PortAssignment {
    project: string;
    service: string;
    hostPort: number;
    containerPort: number;
    protocol: "tcp";
}
export interface PlanPortsInput {
    project: string;
    services: PortServiceRequest[];
    rangeStart: number;
    rangeEnd: number;
    reservations: PortReservation[];
}
type PortChecker = (port: number) => Promise<boolean>;
export declare function parsePortReservations(records: MemoryRecord[]): PortReservation[];
export declare function planPorts(input: PlanPortsInput, checker?: PortChecker): Promise<PortAssignment[]>;
export declare function reservationKey(project: string, service: string, protocol: "tcp"): string;
export declare function isTcpPortAvailable(port: number): Promise<boolean>;
export {};
