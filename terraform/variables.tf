variable "github_access_token" {
  description = "GitHub personal access token with repo and admin:repo_hook permissions (for Amplify webhooks)"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for song composition via Claude"
  type        = string
  sensitive   = true
}

variable "suno_api_key" {
  description = "Suno API key for audio generation (optional — omit to use the mock provider)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "nextauth_secret" {
  description = "Random secret used to sign NextAuth.js JWTs — generate with: openssl rand -base64 32"
  type        = string
  sensitive   = true
}

variable "nextauth_url" {
  description = "Canonical URL of the deployed app, e.g. https://main.abc123.amplifyapp.com. Update after first deploy if using the Amplify default domain."
  type        = string
}
