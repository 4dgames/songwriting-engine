variable "github_access_token" {
  description = "GitHub personal access token with repo and admin:repo_hook permissions"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key — used when LLM gateway is not available (e.g. Amplify Hosting)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "llm_gateway_url" {
  description = "Amplify internal LLM gateway URL — set when deploying inside the VPN"
  type        = string
  default     = ""
}

variable "llm_gateway_api_key" {
  description = "Amplify internal LLM gateway API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_client_id" {
  description = "Google OAuth client ID for NextAuth sign-in"
  type        = string
  sensitive   = true
}

variable "google_client_secret" {
  description = "Google OAuth client secret for NextAuth sign-in"
  type        = string
  sensitive   = true
}

variable "nextauth_secret" {
  description = "Random secret used to sign NextAuth.js JWTs — generate with: openssl rand -base64 32"
  type        = string
  sensitive   = true
}

variable "nextauth_url" {
  description = "Canonical URL of the deployed app, e.g. https://main.abc123.amplifyapp.com"
  type        = string
}

variable "elevenlabs_api_key" {
  description = "ElevenLabs API key for vocal stem separation"
  type        = string
  sensitive   = true
  default     = ""
}

variable "deepgram_api_key" {
  description = "Deepgram API key for live vocal transcription"
  type        = string
  sensitive   = true
  default     = ""
}

variable "fal_key" {
  description = "Fal.ai API key for audio generation"
  type        = string
  sensitive   = true
  default     = ""
}

variable "replicate_api_token" {
  description = "Replicate API token for audio generation"
  type        = string
  sensitive   = true
  default     = ""
}

variable "suno_api_key" {
  description = "Suno API key for audio generation (optional — omit to use the mock provider)"
  type        = string
  sensitive   = true
  default     = ""
}
