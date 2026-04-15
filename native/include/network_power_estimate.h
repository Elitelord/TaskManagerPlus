#pragma once

// Heuristic NIC power model (W) from PDH-style totals: bytes/sec sent+recv and
// max link speed (bps). Uses GetIfTable2 to prefer Wi‑Fi vs Ethernet constants.
double network_power_estimate_watts(double net_send_bps, double net_recv_bps, double net_link_max_bps);
