// The GeoLite2 test databases next to this file, GeoLite2-City.mmdb and GeoLite2-ASN.mmdb, were written once by this
// program with MaxMind's own writer, github.com/maxmind/mmdbwriter v1.2.0 (Apache-2.0 or MIT), because the toolchain
// has no Go. They hold only documentation networks (RFC 5737, RFC 3849) and documentation AS numbers (RFC 5398), in
// the layouts of GeoLite2 City and GeoLite2 ASN; 203.0.113.0/25 holds 1,200-character strings for the bounds. MaxMind's
// own published test databases may be committed (Apache-2.0 or MIT), but they hold only networks outside the
// documentation ranges, which this repository never names. Never commit the real GeoLite2 files.
//
// To write them again (Docker, in an empty directory with this file as main.go):
//   docker run --rm -v "$PWD:/w" -w /w golang:1.25-bookworm sh -c \
//     'go mod init example.com/geowriter && go get github.com/maxmind/mmdbwriter@v1.2.0 && go run .'
package main

import (
	"log"
	"net"
	"os"
	"strings"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
)

func names(en string) mmdbtype.Map { return mmdbtype.Map{"en": mmdbtype.String(en)} }

func write(path, kind string, entries map[string]mmdbtype.Map) {
	tree, err := mmdbwriter.New(mmdbwriter.Options{
		DatabaseType:            kind,
		Description:             map[string]string{"en": "Maane test data: documentation networks only"},
		IncludeReservedNetworks: true,
		RecordSize:              24,
	})
	if err != nil {
		log.Fatal(err)
	}
	for network, data := range entries {
		_, ipnet, err := net.ParseCIDR(network)
		if err != nil {
			log.Fatal(err)
		}
		if err := tree.Insert(ipnet, data); err != nil {
			log.Fatal(err)
		}
	}
	file, err := os.Create(path)
	if err != nil {
		log.Fatal(err)
	}
	defer file.Close()
	if _, err := tree.WriteTo(file); err != nil {
		log.Fatal(err)
	}
}

func city(iso, country, region, name string) mmdbtype.Map {
	return mmdbtype.Map{
		"city":         mmdbtype.Map{"names": names(name)},
		"country":      mmdbtype.Map{"iso_code": mmdbtype.String(iso), "names": names(country)},
		"subdivisions": mmdbtype.Slice{mmdbtype.Map{"names": names(region)}},
	}
}

func asn(number uint32, organization string) mmdbtype.Map {
	return mmdbtype.Map{
		"autonomous_system_number":       mmdbtype.Uint32(number),
		"autonomous_system_organization": mmdbtype.String(organization),
	}
}

func main() {
	long := strings.Repeat("Long", 300)
	write("GeoLite2-City.mmdb", "GeoLite2-City", map[string]mmdbtype.Map{
		"192.0.2.0/24":    city("IL", "Israel", "Tel Aviv District", "Tel Aviv"),
		"198.51.100.0/24": city("GB", "United Kingdom", "England", "London"),
		"203.0.113.0/25":  city("XX", long, long, long),
		"2001:db8::/32":   city("DE", "Germany", "Berlin", "Berlin"),
	})
	write("GeoLite2-ASN.mmdb", "GeoLite2-ASN", map[string]mmdbtype.Map{
		"192.0.2.0/24":    asn(64496, "Example Net"),
		"198.51.100.0/24": asn(64497, "Example Scanning"),
		"203.0.113.0/25":  asn(64498, long),
		"2001:db8::/32":   asn(64499, "Example Six"),
	})
}
