const INTELLICAR_BASE = 'https://apiplatform.intellicar.in/api/standard';
const USERNAME = process.env.INTELLICAR_USERNAME || '';
const PASSWORD = process.env.INTELLICAR_PASSWORD || '';

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
        return cachedToken.token;
    }

    if (!USERNAME || !PASSWORD) {
        throw new Error('INTELLICAR_USERNAME and INTELLICAR_PASSWORD must be set');
    }

    const res = await fetch(`${INTELLICAR_BASE}/gettoken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });

    if (!res.ok) throw new Error(`Intellicar auth failed: ${res.status}`);
    const data = await res.json();
    const token = data.token || data.accessToken;
    if (!token) throw new Error('No token in Intellicar response');

    cachedToken = { token, expiresAt: Date.now() + 55 * 60 * 1000 }; // 55 min cache
    return token;
}

async function postToIntellicar(endpoint: string, body: Record<string, unknown>) {
    const token = await getToken();
    const res = await fetch(`${INTELLICAR_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Intellicar ${endpoint} failed (${res.status}): ${text}`);
    }
    return res.json();
}

export async function listVehicles() {
    return postToIntellicar('listvehicledevicemapping', {});
}

export async function getBatteryMetricsHistory(deviceId: string, startTime: string, endTime: string) {
    return postToIntellicar('getbatterymetricshistory', {
        deviceid: deviceId,
        starttime: startTime,
        endtime: endTime,
    });
}

export async function getGPSHistory(deviceId: string, startTime: string, endTime: string) {
    return postToIntellicar('getgpshistory', {
        deviceid: deviceId,
        starttime: startTime,
        endtime: endTime,
    });
}

export async function getDistanceTravelled(deviceId: string, startTime: string, endTime: string) {
    return postToIntellicar('getdistancetravelled', {
        deviceid: deviceId,
        starttime: startTime,
        endtime: endTime,
    });
}

export async function getLatestCAN(deviceId: string) {
    return postToIntellicar('getlatestcan', { deviceid: deviceId });
}

export async function getLastGPSStatus(deviceId: string) {
    return postToIntellicar('getlastgpsstatus', { deviceid: deviceId });
}
