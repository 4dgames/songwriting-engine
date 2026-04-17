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
    ANTHROPIC_API_KEY = var.anthropic_api_key
    SUNO_API_KEY      = var.suno_api_key
    NEXTAUTH_SECRET   = var.nextauth_secret
    NEXTAUTH_URL      = var.nextauth_url
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
