output "app_id" {
  description = "Amplify app ID"
  value       = aws_amplify_app.songwriting_engine.id
}

output "default_domain" {
  description = "Amplify default domain — use this as NEXTAUTH_URL on first deploy"
  value       = "https://main.${aws_amplify_app.songwriting_engine.default_domain}"
}

output "app_arn" {
  description = "Amplify app ARN"
  value       = aws_amplify_app.songwriting_engine.arn
}
