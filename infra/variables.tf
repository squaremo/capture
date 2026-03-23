variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude intent detection"
  sensitive   = true
}

variable "tailscale_auth_key" {
  description = "Tailscale auth key (generate at tailscale.com/admin/settings/keys — use ephemeral:false, reusable:false)"
  sensitive   = true
}

variable "ts_api_key" {
  description = "Tailscale API key — used by Terraform to manage the tailnet ACL (generate at tailscale.com/admin/settings/keys)"
  sensitive   = true
}

variable "tailscale_tailnet" {
  description = "Your Tailscale tailnet hostname suffix, e.g. 'tail1234.ts.net' or 'yourname.github'"
}

variable "ssh_public_key" {
  description = "SSH public key to install on the server"
}

variable "server_name" {
  description = "Server hostname (also becomes the Tailscale machine name)"
  default     = "capture"
}

variable "location" {
  description = "Hetzner datacenter location"
  default     = "nbg1"

  validation {
    condition     = contains(["fsn1", "nbg1", "hel1", "ash", "hil"], var.location)
    error_message = "Must be a valid Hetzner location: fsn1, nbg1, hel1, ash, hil."
  }
}

variable "server_type" {
  description = "Hetzner server type"
  default     = "cpx22" # 2 vCPU AMD, 4 GB RAM (CPX Gen2, globally available)
}

variable "repo_url" {
  description = "Git repository URL to clone on the server"
  default     = "https://github.com/squaremo/capture.git"
}
