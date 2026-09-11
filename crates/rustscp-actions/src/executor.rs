use crate::schema::{ActionDefinition, FieldType};
use regex::Regex;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ActionError {
    #[error("Missing required field: {0}")]
    MissingRequiredField(String),

    #[error("Validation failed for field '{0}': value '{1}' does not match pattern '{2}'")]
    RegexMismatch(String, String, String),

    #[error("Invalid option '{0}' for field '{1}'")]
    InvalidOption(String, String),

    #[error("Missing context: {0}")]
    MissingContext(String),

    #[error("Template syntax error: {0}")]
    TemplateError(String),
}

pub type ActionResult<T> = Result<T, ActionError>;

#[derive(Debug, Clone, Default)]
pub struct ActionContext {
    pub selected_paths: Vec<String>,
    pub current_remote_dir: String,
}

impl ActionContext {
    pub fn new(current_remote_dir: impl Into<String>, selected_paths: Vec<String>) -> Self {
        Self {
            selected_paths,
            current_remote_dir: current_remote_dir.into(),
        }
    }

    pub fn first_selected_name(&self) -> String {
        self.selected_paths
            .first()
            .and_then(|p| p.split('/').last())
            .unwrap_or("item")
            .to_string()
    }

    pub fn quoted_files(&self) -> String {
        if self.selected_paths.is_empty() {
            "\"\"".to_string()
        } else {
            self.selected_paths
                .iter()
                .map(|p| shell_quote(p))
                .collect::<Vec<_>>()
                .join(" ")
        }
    }
}

/// Safely shell-escape an argument using POSIX single-quote rules
pub fn shell_quote(raw: &str) -> String {
    if raw.is_empty() {
        return "''".to_string();
    }
    // 'text' with internal ' replaced by '\''
    let escaped = raw.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

pub struct ActionExecutor;

impl ActionExecutor {
    /// Validates user-provided parameters against the action definition schema
    pub fn validate_params(
        action: &ActionDefinition,
        params: &HashMap<String, String>,
    ) -> ActionResult<()> {
        for field in &action.fields {
            let val_opt = params.get(&field.id).map(|s| s.trim());

            if field.required {
                match val_opt {
                    None | Some("") => {
                        return Err(ActionError::MissingRequiredField(field.id.clone()));
                    }
                    _ => {}
                }
            }

            if let Some(val) = val_opt {
                if !val.is_empty() {
                    // Check regex validation
                    if let Some(pattern) = &field.validation_regex {
                        let re = Regex::new(pattern)
                            .map_err(|e| ActionError::TemplateError(e.to_string()))?;
                        if !re.is_match(val) {
                            return Err(ActionError::RegexMismatch(
                                field.id.clone(),
                                val.to_string(),
                                pattern.clone(),
                            ));
                        }
                    }

                    // Check select options
                    if let FieldType::Select { options } = &field.field_type {
                        let valid = options.iter().any(|opt| opt.value == val);
                        if !valid {
                            return Err(ActionError::InvalidOption(
                                val.to_string(),
                                field.id.clone(),
                            ));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Renders the action template into a final, safe shell command
    pub fn render_command(
        action: &ActionDefinition,
        context: &ActionContext,
        params: &HashMap<String, String>,
    ) -> ActionResult<String> {
        Self::validate_params(action, params)?;

        let mut rendered = action.template.clone();

        // Context replacements
        rendered = rendered.replace("${selected_files}", &context.quoted_files());
        rendered = rendered.replace("${selected_dir}", &shell_quote(&context.current_remote_dir));
        rendered = rendered.replace("${selected_first_name}", &context.first_selected_name());

        // Field parameters replacements {{field_id}}
        for field in &action.fields {
            let key = format!("{{{{{}}}}}", field.id);
            let val = params
                .get(&field.id)
                .cloned()
                .or_else(|| field.default_value.clone())
                .unwrap_or_default();

            // Safe substitution based on field type
            let safe_val = match &field.field_type {
                FieldType::Text | FieldType::PathPicker => shell_quote(&val),
                FieldType::Number { .. } => {
                    // Sanitize to only numeric chars
                    val.chars()
                        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
                        .collect()
                }
                FieldType::Select { .. } => val, // verified against whitelist
                FieldType::Checkbox => {
                    if val == "true" || val == "1" {
                        "true".to_string()
                    } else {
                        "false".to_string()
                    }
                }
            };

            rendered = rendered.replace(&key, &safe_val);
        }

        Ok(rendered.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{ActionField, LocalizedText, RiskLevel, Scope};

    #[test]
    fn test_shell_quote_escaping() {
        assert_eq!(shell_quote("simple"), "'simple'");
        assert_eq!(
            shell_quote("file with spaces.txt"),
            "'file with spaces.txt'"
        );
        assert_eq!(
            shell_quote("file'with'quotes.txt"),
            "'file'\\''with'\\''quotes.txt'"
        );
        assert_eq!(shell_quote("foo; rm -rf /"), "'foo; rm -rf /'");
    }

    #[test]
    fn test_render_action_command() {
        let action = ActionDefinition {
            id: "tar-gz".to_string(),
            category: "compression".to_string(),
            icon: "archive".to_string(),
            risk_level: RiskLevel::Safe,
            scope: Scope::SelectedFiles,
            name: LocalizedText::new("Compress Tar", "Compactar Tar"),
            description: LocalizedText::new("Create tar.gz", "Criar tar.gz"),
            fields: vec![ActionField {
                id: "archive_name".to_string(),
                field_type: FieldType::Text,
                label: LocalizedText::new("Archive Name", "Nome do Arquivo"),
                description: None,
                default_value: Some("archive.tar.gz".to_string()),
                required: true,
                validation_regex: Some(r"^[a-zA-Z0-9_\-\.]+\.tar\.gz$".to_string()),
                risk_warning: false,
            }],
            template: "tar -czf {{archive_name}} ${selected_files}".to_string(),
        };

        let context = ActionContext::new(
            "/var/www",
            vec![
                "/var/www/index.html".to_string(),
                "/var/www/style.css".to_string(),
            ],
        );

        let mut params = HashMap::new();
        params.insert("archive_name".to_string(), "backup.tar.gz".to_string());

        let cmd = ActionExecutor::render_command(&action, &context, &params).unwrap();
        assert_eq!(
            cmd,
            "tar -czf 'backup.tar.gz' '/var/www/index.html' '/var/www/style.css'"
        );
    }
}
