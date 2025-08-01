const t = require("ava");
const fs = require("fs-extra");
const path = require("path");

const validRecordTypes = ["A", "AAAA", "CAA", "CNAME", "MX", "NS", "SPF", "SRV", "TXT"];

const hostnameRegex = /^(?=.{1,253}$)(?:(?:[_a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)\.)+[a-zA-Z]{2,63}$/;
const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const ipv6Regex =
    /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){0,6}::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}$/;

const domainsPath = path.resolve("domains");
const files = fs.readdirSync(domainsPath);

function expandIPv6(ip) {
    // Split into segments by ":"
    let segments = ip.split(":");

    // Count the number of segments that are empty due to "::" shorthand
    const emptyIndex = segments.indexOf("");
    if (emptyIndex !== -1) {
        // Calculate how many "0000" segments are missing
        const nonEmptySegments = segments.filter((seg) => seg !== "");
        const missingSegments = 8 - nonEmptySegments.length;

        // Insert the missing "0000" segments into the position of the empty segment
        segments = [
            ...nonEmptySegments.slice(0, emptyIndex),
            ...Array(missingSegments).fill("0000"),
            ...nonEmptySegments.slice(emptyIndex)
        ];
    }

    // Expand each segment to 4 characters, padding with leading zeros
    const expandedSegments = segments.map((segment) => segment.padStart(4, "0"));

    // Join the segments back together
    return expandedSegments.join(":");
}

function isPublicIPv4(ip, proxied) {
    const parts = ip.split(".").map(Number);

    // Validate IPv4 address format
    if (parts.length !== 4 || parts.some((part) => isNaN(part) || part < 0 || part > 255)) {
        return false;
    }

    // Exception for 192.0.2.1, assuming the domain is proxied
    if (ip === "192.0.2.1" && proxied) {
        return true;
    }

    // Check for private and reserved IPv4 ranges
    return !(
        // Private ranges
        (
            parts[0] === 10 ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            // Reserved or special-use ranges
            (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || // Carrier-grade NAT
            (parts[0] === 169 && parts[1] === 254) || // Link-local
            (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) || // IETF Protocol Assignments
            (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) || // Documentation (TEST-NET-1)
            (parts[0] === 198 && parts[1] === 18) || // Network Interconnect Devices
            (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) || // Documentation (TEST-NET-2)
            (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) || // Documentation (TEST-NET-3)
            parts[0] >= 224
        ) // Multicast and reserved ranges
    );
}

function isPublicIPv6(ip) {
    const normalizedIP = ip.toLowerCase();

    // Check for private or special-use IPv6 ranges
    return !(
        (
            normalizedIP.startsWith("fc") || // Unique Local Address (ULA)
            normalizedIP.startsWith("fd") || // Unique Local Address (ULA)
            normalizedIP.startsWith("fe80") || // Link-local
            normalizedIP.startsWith("::1") || // Loopback address (::1)
            normalizedIP.startsWith("2001:db8")
        ) // Documentation range
    );
}

function isDirectory(filePath) {
    return fs.lstatSync(filePath).isDirectory();
}

t("All files should have valid record types", (t) => {
    files.forEach((file) => {
        const filePath = path.join(domainsPath, file);

        // Skip directories
        if (isDirectory(filePath)) {
            return;
        }

        const data = fs.readJsonSync(filePath);
        const recordKeys = Object.keys(data.record);

        recordKeys.forEach((key) => {
            t.true(validRecordTypes.includes(key), `${file}: Invalid record type: ${key}`);
        });

        // CNAME records cannot be combined with any other record type
        if (recordKeys.includes("CNAME")) {
            t.is(recordKeys.length, 1, `${file}: CNAME records cannot be combined with other records`);
        }

        // NS records cannot be combined with any other record type, except for DS records
        if (recordKeys.includes("NS")) {
            t.true(
                recordKeys.length === 1 || (recordKeys.length === 2 && recordKeys.includes("DS")),
                `${file}: NS records cannot be combined with other records, except for DS records`
            );
        }
    });
});

function isDirectory(filePath) {
    return fs.lstatSync(filePath).isDirectory();
}

t("All files should not have duplicate record keys", (t) => {
    files.forEach((file) => {
        const filePath = path.join(domainsPath, file);

        // Skip directories
        if (isDirectory(filePath)) {
            return;
        }

        const data = fs.readJsonSync(filePath);

        const recordKeys = Object.keys(data.record);
        const uniqueRecordKeys = new Set(recordKeys);

        t.is(recordKeys.length, uniqueRecordKeys.size, `${file}: Duplicate record keys found`);
    });
});

t("All files should have valid record values", (t) => {
    files.forEach((file) => {
        const filePath = path.join(domainsPath, file);

        // Skip directories
        if (isDirectory(filePath)) {
            return;
        }

        const data = fs.readJsonSync(filePath);

        if (data.record && typeof data.record === 'object') {
            Object.keys(data.record).forEach((key) => {
                const value = data.record[key];

                // *: string[]
                if (["A", "AAAA", "MX", "NS"].includes(key)) {
                    t.true(Array.isArray(value), `${file}: Record value should be an array for ${key}`);

                    value.forEach((record) => {
                        t.true(typeof record === "string", `${file}: Record value should be a string for ${key}`);
                    });

                    // A: string[]
                    if (key === "A") {
                        value.forEach((record) => {
                            t.regex(
                                record,
                                ipv4Regex,
                                `${file}: Record value should be a valid IPv4 address for ${key} at index ${value.indexOf(record)}`
                            );

                            t.true(
                                isPublicIPv4(record, data.proxied),
                                `${file}: Record value should be a public IPv4 address for ${key} at index ${value.indexOf(record)}`
                            );
                        });
                    }

                    // AAAA: string[]
                    if (key === "AAAA") {
                        value.forEach((record) => {
                            t.regex(
                                expandIPv6(record),
                                ipv6Regex,
                                `${file}: Record value should be a valid IPv6 address for ${key} at index ${value.indexOf(record)}`
                            );

                            t.true(
                                isPublicIPv6(record),
                                `${file}: Record value should be a public IPv6 address for ${key} at index ${value.indexOf(record)}`
                            );
                        });
                    }

                    // MX, NS: string[]
                    if (["MX", "NS"].includes(key)) {
                        value.forEach((record) => {
                            t.regex(
                                record,
                                hostnameRegex,
                                `${file}: Record value should be a valid hostname for ${key} at index ${value.indexOf(record)}`
                            );
                        });
                    }
                }

                // CNAME: string
                if (key === "CNAME") {
                    t.true(typeof value === "string", `${file}: Record value should be a string for ${key}`);
                    t.regex(value, hostnameRegex, `${file}: Record value should be a valid hostname for ${key}`);
                }

                // CAA, SRV: object[]
                if (["CAA", "SRV"].includes(key)) {
                    t.true(Array.isArray(value), `${file}: Record value should be an array for ${key}`);

                    value.forEach((record) => {
                        t.true(typeof record === "object", `${file}: Record value should be an object for ${key}`);
                    });

                    if (key === "CAA") {
                        value.forEach((record) => {
                            t.true(typeof record.flags === "number", `${file}: CAA record value should have a number for flags`);
                            t.true(typeof record.tag === "string", `${file}: CAA record value should have a string for tag`);
                            t.true(typeof record.value === "string", `${file}: CAA record value should have a string for value`);
                        });
                    }

                    if (key === "SRV") {
                        value.forEach((record) => {
                            t.true(typeof record.priority === "number", `${file}: SRV record value should have a number for priority`);
                            t.true(typeof record.weight === "number", `${file}: SRV record value should have a number for weight`);
                            t.true(typeof record.port === "number", `${file}: SRV record value should have a number for port`);
                            t.true(typeof record.target === "string", `${file}: SRV record value should have a string for target`);
                            t.regex(record.target, hostnameRegex, `${file}: SRV record value should be a valid hostname for target`);
                        });
                    }
                }

                // TXT, SPF: string | string[]
                if (["SPF", "TXT"].includes(key)) {
                    if (Array.isArray(value)) {
                        value.forEach((record) => {
                            t.true(typeof record === "string", `${file}: Record value should be a string for ${key}`);
                        });
                    } else {
                        t.true(typeof value === "string", `${file}: Record value should be a string for ${key}`);
                    }
                }
            });
        } else {
            t.fail(`Invalid or missing "record" in data: ${JSON.stringify(data)}`);
        }
    });
});
