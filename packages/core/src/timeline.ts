export function timestampInSeconds(timestamp: number | string) {
    if (typeof timestamp === 'number') {
        return timestamp
    }
    const parts = timestamp.split(":").map(Number) as [number, number] | [number, number, number];
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else {
        throw new Error(`Invalid timestamp format: ${timestamp}`);
    }
}

export function formatTimestamp(timestamp: number | string): string {
    const seconds = timestampInSeconds(timestamp);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
    } else {
        return `${minutes}:${secs.toFixed(3).padStart(6, "0")}`;
    }
}