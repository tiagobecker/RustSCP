use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalizedText {
    #[serde(rename = "en-US")]
    pub en_us: String,
    #[serde(rename = "pt-BR")]
    pub pt_br: String,
}

impl LocalizedText {
    pub fn new(en: impl Into<String>, pt: impl Into<String>) -> Self {
        Self {
            en_us: en.into(),
            pt_br: pt.into(),
        }
    }

    pub fn get(&self, lang: &str) -> &str {
        if lang.starts_with("pt") {
            &self.pt_br
        } else {
            &self.en_us
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Safe,
    Warning,
    Dangerous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Global,
    SelectedFiles,
    SelectedDir,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectOption {
    pub value: String,
    pub label: LocalizedText,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Number {
        min: Option<f64>,
        max: Option<f64>,
        step: Option<f64>,
    },
    Select {
        options: Vec<SelectOption>,
    },
    Checkbox,
    PathPicker,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionField {
    pub id: String,
    #[serde(flatten)]
    pub field_type: FieldType,
    pub label: LocalizedText,
    pub description: Option<LocalizedText>,
    pub default_value: Option<String>,
    #[serde(default)]
    pub required: bool,
    pub validation_regex: Option<String>,
    #[serde(default)]
    pub risk_warning: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionDefinition {
    pub id: String,
    pub category: String,
    pub icon: String,
    pub risk_level: RiskLevel,
    pub scope: Scope,
    pub name: LocalizedText,
    pub description: LocalizedText,
    #[serde(default)]
    pub fields: Vec<ActionField>,
    pub template: String,
}
