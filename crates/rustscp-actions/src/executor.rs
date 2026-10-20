use crate::schema::{ActionDefinition, ActionField, FieldType, Scope};
use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;
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

    #[error("Invalid number '{1}' for field '{0}'")]
    InvalidNumber(String, String),

    #[error("Value {1} for field '{0}' is outside the allowed range {2}")]
    OutOfRange(String, String, String),
}

pub type ActionResult<T> = Result<T, ActionError>;

#[derive(Debug, Clone, Default)]
pub struct ActionContext {
    pub selected_paths: Vec<String>,
    pub current_remote_dir: String,
}

fn base_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(trimmed)
}

fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
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
            .map(|p| base_name(p))
            .filter(|n| !n.is_empty())
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

    /// Raw (unquoted) value of a context variable, used inside field default values.
    fn raw_var(&self, name: &str) -> Option<String> {
        let first = self.selected_paths.first().map(String::as_str).unwrap_or("");
        let first_name = self.first_selected_name();
        let (stem, ext) = split_ext(&first_name);
        Some(match name {
            "selected_dir" | "current_dir" => self.current_remote_dir.clone(),
            "selected_file" => first.to_string(),
            "selected_first_name" | "selected_name" => first_name.clone(),
            "selected_stem" => stem.to_string(),
            "selected_ext" => ext.to_string(),
            _ => return None,
        })
    }

    /// Shell-ready value of a context variable (every path is quoted).
    fn quoted_var(&self, name: &str) -> ActionResult<Option<String>> {
        let needs_selection = matches!(
            name,
            "selected_files"
                | "selected_names"
                | "selected_file"
                | "selected_first_name"
                | "selected_name"
                | "selected_stem"
                | "selected_ext"
        );
        if needs_selection && self.selected_paths.is_empty() {
            return Err(ActionError::MissingContext(format!(
                "this action needs selected files (${{{name}}})"
            )));
        }
        Ok(match name {
            "selected_files" => Some(self.quoted_files()),
            "selected_names" => Some(
                self.selected_paths
                    .iter()
                    .map(|p| shell_quote(base_name(p)))
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            other => self.raw_var(other).map(|v| shell_quote(&v)),
        })
    }
}

/// Safely shell-escape an argument using POSIX single-quote rules (`'...'`, with `'`
/// encoded as `'\''`). Delegates to the workspace-wide [`rustscp_core::shell::sh_quote`].
pub fn shell_quote(raw: &str) -> String {
    rustscp_core::shell::sh_quote(raw)
}

/// Leaves simple option-like words (`-6`, `status`, `0644`) bare and quotes anything else.
fn quote_if_needed(raw: &str) -> String {
    let plain = !raw.is_empty()
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.,:=+@%/".contains(&b));
    if plain {
        raw.to_string()
    } else {
        shell_quote(raw)
    }
}

fn token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{\{\s*([A-Za-z_][A-Za-z0-9_\-]*)\s*\}\}|\{%\s*(.*?)\s*%\}")
            .expect("valid token regex")
    })
}

fn cond_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"^if\s+(not\s+)?([A-Za-z_][A-Za-z0-9_\-]*)\s*(?:(==|!=)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_.\-]+)))?$"#,
        )
        .expect("valid condition regex")
    })
}

fn is_truthy(v: &str) -> bool {
    !(v.is_empty() || v == "false" || v == "0")
}

/// Expands `${context}` variables (raw, unquoted) inside a field's default value.
fn expand_default(default: &str, ctx: &ActionContext) -> String {
    let re = token_regex();
    let mut out = String::with_capacity(default.len());
    let mut last = 0;
    for caps in re.captures_iter(default) {
        let m = caps.get(0).expect("match");
        out.push_str(&default[last..m.start()]);
        let replacement = caps
            .get(1)
            .and_then(|name| ctx.raw_var(name.as_str()));
        match replacement {
            Some(v) => out.push_str(&v),
            None => out.push_str(m.as_str()),
        }
        last = m.end();
    }
    out.push_str(&default[last..]);
    out
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
                Self::validate_value(field, val)?;
            }
        }
        Ok(())
    }

    fn validate_value(field: &ActionField, val: &str) -> ActionResult<()> {
        if val.is_empty() {
            return Ok(());
        }
        // Check regex validation
        if let Some(pattern) = &field.validation_regex {
            let re = Regex::new(pattern).map_err(|e| ActionError::TemplateError(e.to_string()))?;
            if !re.is_match(val) {
                return Err(ActionError::RegexMismatch(
                    field.id.clone(),
                    val.to_string(),
                    pattern.clone(),
                ));
            }
        }

        match &field.field_type {
            // Check select options
            FieldType::Select { options } => {
                if !options.iter().any(|opt| opt.value == val) {
                    return Err(ActionError::InvalidOption(val.to_string(), field.id.clone()));
                }
            }
            FieldType::Number { min, max, .. } => {
                let n: f64 = val
                    .parse()
                    .map_err(|_| ActionError::InvalidNumber(field.id.clone(), val.to_string()))?;
                if !n.is_finite()
                    || min.is_some_and(|m| n < m)
                    || max.is_some_and(|m| n > m)
                {
                    let range = format!(
                        "{}..{}",
                        min.map(|m| m.to_string()).unwrap_or_default(),
                        max.map(|m| m.to_string()).unwrap_or_default()
                    );
                    return Err(ActionError::OutOfRange(field.id.clone(), val.to_string(), range));
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Effective raw value of every field: the parameter, or the default value with its
    /// `${context}` variables expanded. Checkbox values are normalized to "true"/"false".
    fn effective_values(
        action: &ActionDefinition,
        context: &ActionContext,
        params: &HashMap<String, String>,
    ) -> ActionResult<HashMap<String, String>> {
        let mut values = HashMap::new();
        for field in &action.fields {
            let provided = params.get(&field.id).map(|s| s.trim().to_string());
            let val = match provided {
                Some(v) => {
                    if field.required && v.is_empty() {
                        return Err(ActionError::MissingRequiredField(field.id.clone()));
                    }
                    Self::validate_value(field, &v)?;
                    v
                }
                None => {
                    let v = field
                        .default_value
                        .as_deref()
                        .map(|d| expand_default(d, context))
                        .unwrap_or_default();
                    if field.required && v.trim().is_empty() {
                        return Err(ActionError::MissingRequiredField(field.id.clone()));
                    }
                    Self::validate_value(field, v.trim())?;
                    v.trim().to_string()
                }
            };
            let val = match field.field_type {
                FieldType::Checkbox => {
                    if val == "true" || val == "1" {
                        "true".to_string()
                    } else {
                        "false".to_string()
                    }
                }
                _ => val,
            };
            values.insert(field.id.clone(), val);
        }
        Ok(values)
    }

    fn render_field(field: &ActionField, val: &str) -> String {
        match &field.field_type {
            FieldType::Text | FieldType::PathPicker => shell_quote(val),
            // Validated as a number in range; only numeric characters can remain.
            FieldType::Number { .. } => val
                .chars()
                .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
                .collect(),
            // Verified against the whitelist; quoted unless it is a plain word.
            FieldType::Select { .. } => quote_if_needed(val),
            FieldType::Checkbox => val.to_string(),
        }
    }

    /// Renders the action template into a final, safe shell command.
    ///
    /// The template is scanned once: `${context}` variables and `{{field}}` placeholders
    /// are replaced by shell-quoted values and substituted text is never rescanned, so a
    /// file or value containing `{{...}}` cannot inject anything. Minimal conditionals are
    /// supported: `{% if field == 'value' %}...{% else %}...{% endif %}` (also `!=`,
    /// `if field` and `if not field`). Unknown `${VAR}`/`{{x}}` are left for the shell.
    pub fn render_command(
        action: &ActionDefinition,
        context: &ActionContext,
        params: &HashMap<String, String>,
    ) -> ActionResult<String> {
        // Provided values are validated here; a required field that is not provided
        // falls back to its default value (validated the same way).
        if action.scope == Scope::SelectedFiles && context.selected_paths.is_empty() {
            return Err(ActionError::MissingContext(
                "select at least one file for this action".to_string(),
            ));
        }
        let values = Self::effective_values(action, context, params)?;
        let fields: HashMap<&str, &ActionField> =
            action.fields.iter().map(|f| (f.id.as_str(), f)).collect();

        let template = &action.template;
        let mut out = String::with_capacity(template.len() + 64);
        // Each entry: (this branch is active, an earlier branch of this if was taken).
        let mut stack: Vec<(bool, bool)> = Vec::new();
        let active = |stack: &Vec<(bool, bool)>| stack.iter().all(|(a, _)| *a);
        let mut last = 0;

        for caps in token_regex().captures_iter(template) {
            let m = caps.get(0).expect("match");
            if active(&stack) {
                out.push_str(&template[last..m.start()]);
            }
            last = m.end();

            if let Some(name) = caps.get(1) {
                if !active(&stack) {
                    continue;
                }
                match context.quoted_var(name.as_str())? {
                    Some(v) => out.push_str(&v),
                    None => out.push_str(m.as_str()),
                }
            } else if let Some(id) = caps.get(2) {
                if !active(&stack) {
                    continue;
                }
                match fields.get(id.as_str()) {
                    Some(field) => {
                        let val = values.get(id.as_str()).map(String::as_str).unwrap_or("");
                        out.push_str(&Self::render_field(field, val));
                    }
                    None => out.push_str(m.as_str()),
                }
            } else if let Some(stmt) = caps.get(3) {
                let stmt = stmt.as_str().trim();
                if stmt == "endif" {
                    if stack.pop().is_none() {
                        return Err(ActionError::TemplateError("unexpected {% endif %}".into()));
                    }
                } else if stmt == "else" {
                    match stack.last_mut() {
                        Some(top) => {
                            let taken = top.1;
                            top.0 = !taken;
                            top.1 = true;
                        }
                        None => {
                            return Err(ActionError::TemplateError("unexpected {% else %}".into()))
                        }
                    }
                } else if let Some(c) = cond_regex().captures(stmt) {
                    let negate = c.get(1).is_some();
                    let id = c.get(2).map(|g| g.as_str()).unwrap_or("");
                    let val = values.get(id).map(String::as_str).unwrap_or("");
                    let mut result = match c.get(3).map(|g| g.as_str()) {
                        Some(op) => {
                            let rhs = c
                                .get(4)
                                .or_else(|| c.get(5))
                                .or_else(|| c.get(6))
                                .map(|g| g.as_str())
                                .unwrap_or("");
                            if op == "==" {
                                val == rhs
                            } else {
                                val != rhs
                            }
                        }
                        None => is_truthy(val),
                    };
                    if negate {
                        result = !result;
                    }
                    stack.push((result, result));
                } else {
                    return Err(ActionError::TemplateError(format!(
                        "unsupported tag {{% {stmt} %}}"
                    )));
                }
            }
        }
        if !stack.is_empty() {
            return Err(ActionError::TemplateError("missing {% endif %}".into()));
        }
        out.push_str(&template[last..]);
        Ok(out.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::ActionCatalog;
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

    fn tar_action() -> ActionDefinition {
        ActionDefinition {
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
        }
    }

    #[test]
    fn test_render_action_command() {
        let action = tar_action();
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

    fn chmod() -> ActionDefinition {
        ActionCatalog::builtin_actions()
            .into_iter()
            .find(|a| a.id == "visual-chmod")
            .unwrap()
    }

    #[test]
    fn test_chmod_recursive_flag_follows_the_checkbox() {
        let ctx = ActionContext::new("/var/www", vec!["/var/www/site".to_string()]);
        let mut params = HashMap::new();
        params.insert("mode".to_string(), "0644".to_string());

        params.insert("recursive".to_string(), "false".to_string());
        let off = ActionExecutor::render_command(&chmod(), &ctx, &params).unwrap();
        params.insert("recursive".to_string(), "true".to_string());
        let on = ActionExecutor::render_command(&chmod(), &ctx, &params).unwrap();
        params.remove("recursive");
        let default = ActionExecutor::render_command(&chmod(), &ctx, &params).unwrap();

        assert_ne!(off, on);
        assert_eq!(default, off, "unchecked by default");
        assert!(off.contains("[ false = true ]"), "{off}");
        assert!(on.contains("[ true = true ]"), "{on}");
        assert!(on.ends_with("0644 '/var/www/site'"), "{on}");
        assert!(!off.contains("{%"));
    }

    #[test]
    fn test_conditional_tags_are_evaluated() {
        let mut action = chmod();
        action.template =
            "chmod {% if recursive == 'true' %}-R {% endif %}{{mode}} ${selected_files}".into();
        let ctx = ActionContext::new("/srv", vec!["/srv/a".to_string()]);
        let mut params = HashMap::new();
        params.insert("mode".to_string(), "0755".to_string());
        params.insert("recursive".to_string(), "false".to_string());
        assert_eq!(
            ActionExecutor::render_command(&action, &ctx, &params).unwrap(),
            "chmod 0755 '/srv/a'"
        );
        params.insert("recursive".to_string(), "true".to_string());
        assert_eq!(
            ActionExecutor::render_command(&action, &ctx, &params).unwrap(),
            "chmod -R 0755 '/srv/a'"
        );

        action.template = "echo {% if not recursive %}flat{% else %}deep{% endif %}".into();
        assert_eq!(
            ActionExecutor::render_command(&action, &ctx, &params).unwrap(),
            "echo deep"
        );
        action.template = "echo {% if recursive %}x".into();
        assert!(matches!(
            ActionExecutor::render_command(&action, &ctx, &params),
            Err(ActionError::TemplateError(_))
        ));
    }

    #[test]
    fn test_substituted_values_are_never_rescanned() {
        let mut action = tar_action();
        action.fields[0].validation_regex = None;
        action.fields.push(ActionField {
            id: "dest_dir".to_string(),
            field_type: FieldType::Text,
            label: LocalizedText::new("d", "d"),
            description: None,
            default_value: Some("$(id)".to_string()),
            required: false,
            validation_regex: None,
            risk_warning: false,
        });
        action.template = "tar -czf {{archive_name}} ${selected_files} -C {{dest_dir}}".into();
        let ctx = ActionContext::new("/x", vec!["/x/{{dest_dir}}".to_string()]);
        let mut params = HashMap::new();
        params.insert("archive_name".to_string(), "{{dest_dir}}".to_string());
        params.insert("dest_dir".to_string(), "'$(id)'".to_string());
        let cmd = ActionExecutor::render_command(&action, &ctx, &params).unwrap();
        assert_eq!(
            cmd,
            "tar -czf '{{dest_dir}}' '/x/{{dest_dir}}' -C ''\\''$(id)'\\'''"
        );
    }

    #[test]
    fn test_empty_selection_is_an_error() {
        let ctx = ActionContext::new("/x", vec![]);
        let mut params = HashMap::new();
        params.insert("mode".to_string(), "0644".to_string());
        assert!(matches!(
            ActionExecutor::render_command(&chmod(), &ctx, &params),
            Err(ActionError::MissingContext(_))
        ));
        let mut any = tar_action();
        any.scope = Scope::Any;
        let mut p = HashMap::new();
        p.insert("archive_name".to_string(), "a.tar.gz".to_string());
        assert!(matches!(
            ActionExecutor::render_command(&any, &ctx, &p),
            Err(ActionError::MissingContext(_))
        ));
    }

    #[test]
    fn test_context_variables_are_quoted() {
        let mut action = tar_action();
        action.fields.clear();
        action.template =
            "echo ${selected_dir} ${current_dir} ${selected_file} ${selected_name} ${selected_stem} ${selected_ext} ${selected_first_name} ${selected_names} ${HOME} {{.Names}}"
                .into();
        let ctx = ActionContext::new("/srv/my site", vec!["/srv/my site/$(x).tar.gz".to_string()]);
        let cmd = ActionExecutor::render_command(&action, &ctx, &HashMap::new()).unwrap();
        assert_eq!(
            cmd,
            "echo '/srv/my site' '/srv/my site' '/srv/my site/$(x).tar.gz' '$(x).tar.gz' '$(x).tar' 'gz' '$(x).tar.gz' '$(x).tar.gz' ${HOME} {{.Names}}"
        );
    }

    #[test]
    fn test_defaults_expand_context_and_are_validated() {
        let tar = ActionCatalog::builtin_actions()
            .into_iter()
            .find(|a| a.id == "tar-compress")
            .unwrap();
        let ctx = ActionContext::new("/var/www", vec!["/var/www/site".to_string()]);
        let cmd = ActionExecutor::render_command(&tar, &ctx, &HashMap::new()).unwrap();
        assert!(cmd.contains("> 'site.tar.gz'"), "{cmd}");
        assert!(cmd.contains("gzip -6"), "{cmd}");
        assert!(cmd.starts_with("cd '/var/www' && "), "{cmd}");

        let spaced = ActionContext::new("/v", vec!["/v/my site".to_string()]);
        assert!(matches!(
            ActionExecutor::render_command(&tar, &spaced, &HashMap::new()),
            Err(ActionError::RegexMismatch(..))
        ));
    }

    #[test]
    fn test_number_fields_are_range_checked() {
        let du = ActionCatalog::builtin_actions()
            .into_iter()
            .find(|a| a.id == "disk-usage")
            .unwrap();
        let ctx = ActionContext::new("/var/log", vec![]);
        let mut p = HashMap::new();
        p.insert("limit".to_string(), "20".to_string());
        let cmd = ActionExecutor::render_command(&du, &ctx, &p).unwrap();
        assert!(cmd.starts_with("cd '/var/log' && du -sh"), "{cmd}");
        assert!(cmd.ends_with("head -n 20"), "{cmd}");
        p.insert("limit".to_string(), "500".to_string());
        assert!(matches!(
            ActionExecutor::render_command(&du, &ctx, &p),
            Err(ActionError::OutOfRange(..))
        ));
        p.insert("limit".to_string(), "5; rm -rf /".to_string());
        assert!(matches!(
            ActionExecutor::render_command(&du, &ctx, &p),
            Err(ActionError::InvalidNumber(..))
        ));
    }

    #[test]
    fn test_every_builtin_renders_with_defaults() {
        let ctx = ActionContext::new(
            "/var/www",
            vec!["/var/www/archive.tar.gz".to_string()],
        );
        for action in ActionCatalog::builtin_actions() {
            let cmd = ActionExecutor::render_command(&action, &ctx, &HashMap::new())
                .unwrap_or_else(|e| panic!("{} failed: {e}", action.id));
            assert!(!cmd.contains("{%"), "{}: {cmd}", action.id);
            assert!(!cmd.contains("${selected"), "{}: {cmd}", action.id);
        }
    }
}
