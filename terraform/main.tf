terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5.0"
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_amplify_app" "songwriting_engine" {
  name       = "songwriting-engine"
  repository = "https://github.com/4dgames/songwriting-engine"

  # GitHub personal access token with repo + admin:repo_hook permissions
  access_token = var.github_access_token

  # WEB_COMPUTE enables Next.js SSR (App Router requires this)
  platform = "WEB_COMPUTE"

  build_spec = <<-EOT
    version: 1
    frontend:
      phases:
        preBuild:
          commands:
            - npm ci
        build:
          commands:
            - npm run build
      artifacts:
        baseDirectory: .next
        files:
          - '**/*'
      cache:
        paths:
          - node_modules/**/*
          - .next/cache/**/*
  EOT

  environment_variables = {
    # LLM providers — gateway takes priority; Anthropic API is the fallback
    ANTHROPIC_API_KEY   = var.anthropic_api_key
    LLM_GATEWAY_URL     = var.llm_gateway_url
    LLM_GATEWAY_API_KEY = var.llm_gateway_api_key

    # Auth
    NEXTAUTH_SECRET      = var.nextauth_secret
    NEXTAUTH_URL         = var.nextauth_url
    GOOGLE_CLIENT_ID     = var.google_client_id
    GOOGLE_CLIENT_SECRET = var.google_client_secret

    # Audio providers
    SUNO_API_KEY        = var.suno_api_key
    ELEVENLABS_API_KEY  = var.elevenlabs_api_key
    DEEPGRAM_API_KEY    = var.deepgram_api_key
    FAL_KEY             = var.fal_key
    REPLICATE_API_TOKEN = var.replicate_api_token

    # Tells Amplify to manage the Next.js framework version
    _LIVE_UPDATES = jsonencode([{
      name    = "Next.js version"
      pkg     = "next-version"
      type    = "internal"
      version = "latest"
    }])
  }


}

resource "aws_amplify_branch" "main" {
  app_id      = aws_amplify_app.songwriting_engine.id
  branch_name = "main"

  framework = "Next.js - SSR"
  stage     = "PRODUCTION"

  enable_auto_build = true

  environment_variables = {
    # Branch-level overrides (if needed) go here
  }
}
