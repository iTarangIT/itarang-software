export interface VehicleDevice {
    deviceId: string;
    vehicleNumber: string;
    vehicleType: string;
    imei?: string;
}

export interface BatteryReading {
    deviceId: string;
    soc: number;
    soh: number;
    voltage: number;
    current: number;
    temperature: number;
    timestamp: string;
}

export interface GPSReading {
    deviceId: string;
    latitude: number;
    longitude: number;
    speed: number;
    heading: number;
    timestamp: string;
}

export interface TripRecord {
    deviceId: string;
    startTime: string;
    endTime: string;
    distance: number;
    startOdometer: number;
    endOdometer: number;
}
