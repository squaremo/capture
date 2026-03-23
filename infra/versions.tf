terraform {
  required_version = ">= 1.10"

  # Backend configured via: terraform init -backend-config=backend.hcl
  backend "s3" {}

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.17"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "tailscale" {
  api_key = var.ts_api_key
}
