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
