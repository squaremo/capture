output "server_ip" {
  description = "Public IP of the server (for SSH)"
  value       = hcloud_server.capture.ipv4_address
}

output "tailscale_fqdn" {
  description = "Tailscale FQDN — use this to access the app once on your tailnet"
  value       = "https://${local.tailscale_fqdn}"
}

output "ssh_command" {
  description = "SSH command to access the server"
  value       = "ssh root@${hcloud_server.capture.ipv4_address}"
}
