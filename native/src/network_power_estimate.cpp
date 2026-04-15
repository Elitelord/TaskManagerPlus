#include "network_power_estimate.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <vector>
#include <cmath>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")

#ifndef IF_TYPE_IEEE80211
#define IF_TYPE_IEEE80211 71
#endif
#ifndef IF_TYPE_ETHERNET_CSMACD
#define IF_TYPE_ETHERNET_CSMACD 6
#endif
#ifndef IF_TYPE_SOFTWARE_LOOPBACK
#define IF_TYPE_SOFTWARE_LOOPBACK 24
#endif
#ifndef IF_TYPE_TUNNEL
#define IF_TYPE_TUNNEL 131
#endif

static void pick_primary_adapter_type(ULONG& out_type, ULONG64& out_max_link_bps) {
    out_type = IF_TYPE_ETHERNET_CSMACD;
    out_max_link_bps = 0;

    ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    ULONG bufLen = 0;
    if (GetAdaptersAddresses(AF_UNSPEC, flags, nullptr, nullptr, &bufLen) != ERROR_BUFFER_OVERFLOW)
        return;

    std::vector<BYTE> buf(bufLen);
    auto* addrs = reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buf.data());
    if (GetAdaptersAddresses(AF_UNSPEC, flags, nullptr, addrs, &bufLen) != NO_ERROR)
        return;

    for (PIP_ADAPTER_ADDRESSES a = addrs; a; a = a->Next) {
        if (a->OperStatus != IfOperStatusUp) continue;
        if (a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
        if (a->IfType == IF_TYPE_TUNNEL) continue;

        ULONG64 spd = static_cast<ULONG64>(a->TransmitLinkSpeed);
        if (static_cast<ULONG64>(a->ReceiveLinkSpeed) > spd)
            spd = static_cast<ULONG64>(a->ReceiveLinkSpeed);
        if (spd < 10ULL * 1000 * 1000) continue;

        if (spd >= out_max_link_bps) {
            out_max_link_bps = spd;
            out_type = a->IfType;
        }
    }
}

double network_power_estimate_watts(double net_send_bps, double net_recv_bps, double net_link_max_bps) {
    ULONG best_type = IF_TYPE_ETHERNET_CSMACD;
    ULONG64 best_link = 0;
    pick_primary_adapter_type(best_type, best_link);

    const bool is_wifi = (best_type == IF_TYPE_IEEE80211);

    double link_bps = net_link_max_bps;
    if (link_bps < 1000.0 && best_link > 0)
        link_bps = static_cast<double>(best_link);

    const double throughput_bps = (net_send_bps + net_recv_bps) * 8.0;
    double util = 0.0;
    if (link_bps > 1000.0) {
        util = throughput_bps / link_bps;
    } else {
        util = (net_send_bps + net_recv_bps) / (50.0 * 1e6 / 8.0);
    }
    if (util < 0.0) util = 0.0;
    if (util > 1.0) util = 1.0;

    const double idle = is_wifi ? 0.5 : 0.2;
    const double span = is_wifi ? 3.5 : 1.8;
    return idle + util * span;
}
