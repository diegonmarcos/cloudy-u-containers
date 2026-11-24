package router

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Self is this router's own name.
const Self = "cloudy-all-mcp"

func mesh(host string, port int) string {
	return fmt.Sprintf("http://%s.mesh.diegonmarcos.com:%d/mcp", host, port)
}
func pub(path string) string { return "https://c3-pvt.diegonmarcos.com/" + path + "/mcp" }

// DefaultCatalog is the fleet servers the router fronts: mesh first, public bearer route second.
func DefaultCatalog() []ServerEntry {
	return []ServerEntry{
		{Name: "cloudy-c3-mcp", Aliases: []string{"cloud-infra-mcp", "c3-infra-mcp"}, Description: "c3 fleet control plane: devops, VMs, workflows, DNS, secrets", URLs: []string{mesh("cloudy-c3-mcp", 3100), pub("cloudy-c3-mcp")}},
		{Name: "cloudy-android-mcp", Aliases: []string{"cloud-superapp-mcp"}, Description: "Android super-app and device tools", URLs: []string{mesh("cloudy-android-mcp", 3110), pub("cloudy-android-mcp")}},
		{Name: "cloudy-apps-communication-mcp", Aliases: []string{"cloud-mail-mcp", "cloud-mattermost-mcp"}, Description: "Mail (IMAP/SMTP/Stalwart/Resend) and Mattermost: tools `mail` and `mattermost`", URLs: []string{mesh("cloudy-apps-communication-mcp", 3103), pub("cloudy-apps-communication-mcp")}},
		{Name: "cloudy-apps-drive-mcp", Aliases: []string{"cloud-drive-mcp", "cloud-vault-mcp"}, Description: "Drive (repos, files, photos, S3, convert) and, on a direct mesh hit only, the cloud_vault personal data tool", URLs: []string{mesh("cloudy-apps-drive-mcp", 3109), pub("cloudy-apps-drive-mcp")}},
		{Name: "cloudy-cgc-pub-mcp", Aliases: []string{"cloud-cgc-pub-mcp"}, Description: "Public code graph (CGC)", URLs: []string{mesh("cloudy-cgc-pub-mcp", 3105), pub("cloudy-cgc-pub-mcp")}},
		{Name: "cloud-me-cgc-pvt-mcp", Aliases: []string{"cloud-cgc-pvt-mcp"}, Description: "Private code graph (cloud-me), mesh only", URLs: []string{mesh("cloud-me-cgc-pvt-mcp", 3107)}},
		{Name: "google-workspace-mcp", Description: "Google Workspace (Drive, Docs, Sheets, Calendar, Gmail)", URLs: []string{mesh("g-workspace-mcp", 3104)}},
		{Name: "google-personal-mcp", Description: "Personal Google account", URLs: []string{mesh("g-personal-mcp", 3106)}},
		{Name: "services", Aliases: []string{"cloud-services-mcp"}, Description: "Legacy per-service tools (gitea, ntfy, umami, grist, ...), served by the old cloud-services-mcp container until re-homed", URLs: []string{mesh("c3-services-mcp", 3101)}},
	}
}

// LoadCatalog returns DefaultCatalog, or the ROUTER_SERVERS JSON array (which replaces it wholesale).
func LoadCatalog(env func(string) string) ([]ServerEntry, error) {
	raw := env("ROUTER_SERVERS")
	if raw == "" {
		return DefaultCatalog(), nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, err
	}
	bad := errors.New("ROUTER_SERVERS must be a JSON array of {name, description, urls[], aliases?[]}")
	arr, ok := parsed.([]any)
	if !ok {
		return nil, bad
	}
	for _, x := range arr {
		m, ok := x.(map[string]any)
		if !ok {
			return nil, bad
		}
		if _, ok := m["name"].(string); !ok {
			return nil, bad
		}
		if _, ok := m["urls"].([]any); !ok {
			return nil, bad
		}
	}
	var out []ServerEntry
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	return out, nil
}
