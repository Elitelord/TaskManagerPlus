/**
 * Common USB vendor IDs → human-readable vendor names.
 *
 * Used as a fallback when the device's SPDRP_MFG string is empty or generic
 * (e.g. "(Standard USB devices)"). Covers ~60 of the most common consumer
 * vendors — enough to make the devices list feel informative without
 * bundling the full 20k-entry USB-IF database.
 */

const VENDORS: Readonly<Record<number, string>> = {
  0x03f0: "HP",
  0x0424: "Microchip",
  0x0451: "Texas Instruments",
  0x0458: "KYE Systems",
  0x045e: "Microsoft",
  0x046d: "Logitech",
  0x0483: "STMicroelectronics",
  0x04ca: "Lite-On",
  0x04d9: "Holtek",
  0x04e8: "Samsung",
  0x04f2: "Chicony",
  0x04f3: "Elan",
  0x056a: "Wacom",
  0x05ac: "Apple",
  0x05e3: "Genesys Logic",
  0x067b: "Prolific",
  0x0781: "SanDisk",
  0x07ca: "AVerMedia",
  0x0835: "Action Star",
  0x0853: "TopSeed",
  0x08bb: "Texas Instruments (Audio)",
  0x090c: "Silicon Motion",
  0x093a: "Pixart Imaging",
  0x09da: "A4Tech",
  0x0b05: "ASUS",
  0x0bb4: "HTC",
  0x0bda: "Realtek",
  0x0c45: "Microdia",
  0x0cf3: "Qualcomm Atheros",
  0x0d8c: "C-Media",
  0x10c4: "Silicon Labs",
  0x1050: "Yubico",
  0x1209: "Generic / InterBiometrics",
  0x13d3: "IMC Networks",
  0x1532: "Razer",
  0x1546: "U-Blox",
  0x152d: "JMicron",
  0x1668: "Actiontec",
  0x17ef: "Lenovo",
  0x18d1: "Google",
  0x1a2c: "China Resource Semi-Conductor",
  0x1a40: "Terminus Technology",
  0x1a86: "QinHeng / CH340",
  0x1b1c: "Corsair",
  0x1bcf: "Sunplus Innovation",
  0x1e7d: "ROCCAT",
  0x2109: "VIA Labs",
  0x2357: "TP-Link",
  0x24ae: "Shenzhen Huiding (Goodix)",
  0x258a: "SINO WEALTH",
  0x25a7: "Areson Technology",
  0x27c6: "Shenzhen Goodix",
  0x2833: "Meta (Oculus)",
  0x2ca3: "DJI",
  0x8087: "Intel",
  0x8564: "Transcend",
};

/** Lookup vendor name, or "" when unknown. Pass a 16-bit VID. */
export function vendorForVid(vid: number): string {
  return VENDORS[vid] ?? "";
}

const GENERIC_MANUFACTURERS = new Set([
  "",
  "(standard usb devices)",
  "(standard system devices)",
  "compatible usb storage device",
  "generic",
  "usb",
]);

/** Returns `manufacturer` if it looks meaningful, otherwise a VID-based
 *  fallback (or "" if VID is unknown). */
export function bestManufacturerName(manufacturer: string, vid: number): string {
  const m = manufacturer.trim();
  if (!GENERIC_MANUFACTURERS.has(m.toLowerCase())) return m;
  return vendorForVid(vid);
}
