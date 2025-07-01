# Contributing to MetaMover

Thank you for your interest in contributing to MetaMover! This document provides guidelines and information for contributors.

## 🤝 How to Contribute

We welcome contributions of all kinds:
- 🐛 **Bug reports** and feature requests
- 📝 **Documentation** improvements
- 🔧 **Code contributions** and bug fixes
- 🧪 **Testing** and quality assurance
- 💡 **Ideas** and feature suggestions

## 🚀 Getting Started

### Prerequisites

1. **Python 3.6+** installed on your system
2. **ExifTool** installed and accessible via PATH
3. **Git** for version control
4. **Basic knowledge** of Python and media file processing

### Development Setup

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/your-username/metamover.git
   cd metamover
   ```

3. **Create a virtual environment**:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

4. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   pip install pytest black flake8  # Development tools
   ```

5. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## 📋 Development Guidelines

### Code Style

We use **Black** for code formatting and **flake8** for linting:

```bash
# Format code
black *.py

# Check linting
flake8 *.py
```

**Key style guidelines:**
- Follow PEP 8 conventions
- Use meaningful variable and function names
- Include docstrings for all functions and classes
- Keep lines under 88 characters (Black default)
- Use type hints where appropriate

### Code Structure

**Header Format:**
All new Python files should include the standardized ASCII art header:

```python
#!/usr/bin/env python3

####################################################################################
#                                                                                  #
#    ██████╗ ███████╗████████╗   ███████╗██╗    ██╗██╗███████╗████████╗██╗   ██╗   #
#   ██╔════╝ ██╔════╝╚══██╔══╝   ██╔════╝██║    ██║██║██╔════╝╚══██╔══╝╚██╗ ██╔╝   #
#   ██║  ███╗█████╗     ██║      ███████╗██║ █╗ ██║██║█████╗     ██║    ╚████╔╝    #
#   ██║   ██║██╔══╝     ██║      ╚════██║██║███╗██║██║██╔══╝     ██║     ╚██╔╝     #
#   ╚██████╔╝███████╗   ██║      ███████║╚███╔███╔╝██║██╗        ██║      ██║      #
#    ╚═════╝ ╚══════╝   ╚═╝      ╚══════╝ ╚══╝╚══╝ ╚═╝╚═╝        ╚═╝      ╚═╝      #
#                                                                                  #
####################################################################################
#
# Script Name: your-script-name.py                                                #
# 
# Author: your-email@domain.com                                                  #
#                                              
# Date Created: YYYY-MM-DD                                                       #
#
# Last Modified: YYYY-MM-DD                                                      #
#
# Version: X.Y.Z                                                                 #
#
# Description: Brief description of what this script does                        #
#
# Usage: python your-script-name.py                                              #
#
# Dependencies: list of dependencies                                              #
#                                                                                  #
# GitHub: https://github.com/your-repo/metamover                                 #
#                                                                                  #
# Notes: Additional notes or special instructions                                 #
#                                                                                  #
####################################################################################
```

**Function Documentation:**
```python
def process_file(file_path: str, options: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Process a media file with the given options.
    
    Args:
        file_path: Path to the file to process
        options: Dictionary of processing options
        
    Returns:
        Tuple of (success, message)
        
    Raises:
        FileNotFoundError: If the file doesn't exist
        PermissionError: If file access is denied
    """
    # Implementation here
    pass
```

### Testing

**Running Tests:**
```bash
pytest tests/
```

**Writing Tests:**
- Create test files in the `tests/` directory
- Use descriptive test function names
- Test both success and failure cases
- Include edge cases and boundary conditions

**Test Example:**
```python
import pytest
from your_module import process_file

def test_process_file_success():
    """Test successful file processing."""
    result = process_file("test_image.jpg", {"organize": True})
    assert result[0] is True
    assert "processed successfully" in result[1].lower()

def test_process_file_missing_file():
    """Test handling of missing files."""
    with pytest.raises(FileNotFoundError):
        process_file("nonexistent.jpg", {})
```

## 🐛 Bug Reports

When reporting bugs, please include:

**Bug Report Template:**
```markdown
## Bug Description
Brief description of the issue

## Steps to Reproduce
1. Step one
2. Step two
3. Step three

## Expected Behavior
What you expected to happen

## Actual Behavior
What actually happened

## Environment
- OS: [e.g., macOS 12.0, Windows 11, Ubuntu 20.04]
- Python version: [e.g., 3.9.7]
- ExifTool version: [e.g., 12.50]
- MetaMover version: [e.g., 1.0.0]

## Additional Context
- File types involved
- Collection size
- Error messages or logs
- Screenshots if applicable
```

## 💡 Feature Requests

**Feature Request Template:**
```markdown
## Feature Description
Clear description of the proposed feature

## Use Case
Why is this feature needed? What problem does it solve?

## Proposed Implementation
How do you envision this working?

## Alternatives Considered
Any alternative solutions you've considered

## Additional Context
Any other context, mockups, or examples
```

## 🔧 Pull Requests

### Before Submitting

1. **Ensure your code follows** the style guidelines
2. **Run tests** and ensure they pass
3. **Update documentation** if necessary
4. **Add tests** for new functionality
5. **Update CHANGELOG.md** with your changes

### Pull Request Process

1. **Create a descriptive title**:
   - ✅ "Add GPU acceleration for Linux systems"
   - ❌ "Fix stuff"

2. **Use the PR template**:
   ```markdown
   ## Description
   Brief description of changes
   
   ## Type of Change
   - [ ] Bug fix (non-breaking change that fixes an issue)
   - [ ] New feature (non-breaking change that adds functionality)
   - [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
   - [ ] Documentation update
   
   ## Testing
   - [ ] I have tested these changes locally
   - [ ] I have added appropriate tests
   - [ ] All existing tests pass
   
   ## Checklist
   - [ ] Code follows project style guidelines
   - [ ] Self-review completed
   - [ ] Documentation updated if necessary
   - [ ] CHANGELOG.md updated
   ```

3. **Link related issues**: Reference any related issues in your PR description

4. **Request review**: Tag relevant maintainers for review

## 📚 Documentation

**Types of Documentation:**
- **Code comments**: Explain complex logic
- **Docstrings**: Document functions and classes
- **README updates**: Keep usage instructions current
- **Tutorials**: Step-by-step guides for new features
- **API documentation**: Comprehensive API reference

**Documentation Style:**
- Use clear, concise language
- Include practical examples
- Keep it up-to-date with code changes
- Consider different user skill levels

## 🏗 Project Structure

```
MetaMover/
├── README.md              # Project overview and setup
├── requirements.txt       # Python dependencies
├── .gitignore            # Git ignore patterns
├── LICENSE               # MIT license
├── CHANGELOG.md          # Version history
├── CONTRIBUTING.md       # This file
├── media-*.py           # Main tool scripts
├── tests/               # Test files
├── docs/                # Additional documentation
├── examples/            # Usage examples
└── .github/             # GitHub templates and workflows
```

## 🎯 Development Priorities

**Current Focus Areas:**
1. **Cross-platform GPU acceleration** (Windows/Linux)
2. **Performance optimization** for large collections
3. **Test coverage improvement**
4. **Documentation expansion**
5. **Error handling enhancement**

**Future Roadmap:**
- Database integration for metadata indexing
- Web-based interface
- Cloud storage integration
- Machine learning features
- Plugin system architecture

## 🤔 Questions and Support

**Getting Help:**
- 📧 **Email**: Contact the maintainers directly
- 💬 **GitHub Issues**: Ask questions via GitHub issues
- 📚 **Documentation**: Check existing documentation first
- 🔍 **Search**: Search existing issues before creating new ones

**Response Times:**
- **Bug reports**: 1-3 business days
- **Feature requests**: 1-2 weeks for initial response
- **Pull requests**: 3-7 days for review
- **Questions**: 1-3 business days

## 🏆 Recognition

Contributors will be recognized in:
- **README.md**: Contributors section
- **Release notes**: Major contribution acknowledgments
- **GitHub contributors**: Automatic GitHub recognition
- **CHANGELOG.md**: Feature attribution

## 📝 License

By contributing to MetaMover, you agree that your contributions will be licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

## Code of Conduct

### Our Pledge

We pledge to make participation in our project a harassment-free experience for everyone, regardless of age, body size, disability, ethnicity, gender identity and expression, level of experience, nationality, personal appearance, race, religion, or sexual identity and orientation.

### Our Standards

**Examples of behavior that contributes to creating a positive environment:**
- Using welcoming and inclusive language
- Being respectful of differing viewpoints and experiences
- Gracefully accepting constructive criticism
- Focusing on what is best for the community
- Showing empathy towards other community members

**Examples of unacceptable behavior:**
- The use of sexualized language or imagery
- Trolling, insulting/derogatory comments, and personal attacks
- Public or private harassment
- Publishing others' private information without permission
- Other conduct which could reasonably be considered inappropriate

### Enforcement

Project maintainers are responsible for clarifying standards of acceptable behavior and will take appropriate and fair corrective action in response to any instances of unacceptable behavior.

---

**Thank you for contributing to MetaMover! 🙏**

Your contributions help make this project better for photographers, videographers, and digital asset managers worldwide.