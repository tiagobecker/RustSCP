use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMaskFilter {
    pub raw_mask: String,
    #[serde(skip)]
    include_patterns: Vec<Regex>,
    #[serde(skip)]
    exclude_patterns: Vec<Regex>,
}

impl FileMaskFilter {
    pub fn new(mask_str: &str) -> Self {
        let mut include = Vec::new();
        let mut exclude = Vec::new();

        for part in mask_str
            .split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            let (is_exclude, clean_pattern) = if let Some(stripped) = part.strip_prefix('!') {
                (true, stripped)
            } else {
                (false, part)
            };

            let regex_str = wildcard_to_regex(clean_pattern);
            if let Ok(re) = Regex::new(&regex_str) {
                if is_exclude {
                    exclude.push(re);
                } else {
                    include.push(re);
                }
            }
        }

        Self {
            raw_mask: mask_str.to_string(),
            include_patterns: include,
            exclude_patterns: exclude,
        }
    }

    /// Checks if a file or directory matches the mask rules
    pub fn matches(&self, filename: &str, _is_dir: bool) -> bool {
        // If there are exclude rules and any matches, reject
        for ex in &self.exclude_patterns {
            if ex.is_match(filename) {
                return false;
            }
        }

        // If there are include rules, at least one must match
        if !self.include_patterns.is_empty() {
            let mut matched = false;
            for inc in &self.include_patterns {
                if inc.is_match(filename) {
                    matched = true;
                    break;
                }
            }
            if !matched {
                return false;
            }
        }

        true
    }
}

fn wildcard_to_regex(wildcard: &str) -> String {
    let mut regex = String::from("^");
    for ch in wildcard.chars() {
        match ch {
            '*' => regex.push_str(".*"),
            '?' => regex.push('.'),
            '.' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\' => {
                regex.push('\\');
                regex.push(ch);
            }
            _ => regex.push(ch),
        }
    }
    regex.push('$');
    regex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_mask_matching() {
        let filter = FileMaskFilter::new("*.txt; *.html; !*.bak; !.git*");
        assert!(filter.matches("index.html", false));
        assert!(filter.matches("notes.txt", false));
        assert!(!filter.matches("backup.bak", false));
        assert!(!filter.matches(".git", true));
        assert!(!filter.matches("app.exe", false));
    }
}
