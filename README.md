# CSV Analysis with OpenAI

A modern web application that allows you to upload CSV files, analyze them using OpenAI's GPT-4 API, and export the results. Perfect for survey research and qualitative data analysis.

## Features

- 📁 **CSV Upload**: Drag and drop or browse to upload CSV files
- 🤖 **AI Analysis**: Uses OpenAI GPT-4 to identify themes in your data
- 📊 **Structured Output**: Returns themes with labels, definitions, keywords, and participant IDs
- 💾 **CSV Export**: Download analysis results as a CSV file
- 🎨 **Modern UI**: Clean, responsive design with beautiful animations
- 🔒 **Secure**: API keys are handled client-side and not stored

## Prerequisites

- Node.js (version 16 or higher)
- OpenAI API key (get one from [OpenAI Platform](https://platform.openai.com/api-keys))

## Installation

1. Clone or download this repository
2. Navigate to the project directory:
   ```bash
   cd amview-verbs2
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

5. Open your browser and go to `http://localhost:3000`

## Usage

### 1. Configure OpenAI API
- Enter your OpenAI API key in the first section
- Your API key is stored locally and never sent to any server except OpenAI

### 2. Upload CSV File
- Drag and drop your CSV file onto the upload area, or click to browse
- The app will automatically parse and display the number of rows loaded

### 3. Analyze Data
- Click "Analyze with OpenAI" to process your data
- The app uses a predefined prompt designed for survey research analysis
- Results will show identified themes with their definitions, keywords, and participant IDs

### 4. Export Results
- Click "Export to CSV" to download the analysis results
- The exported file will include all theme information in a structured format

## Analysis Prompt

The application uses a specialized prompt for survey research analysis:

```
Your role: You are a senior survey research analyst.
Your task: read the list of open-ended responses to the survey questions in the attached csv and identify the key themes.
Instructions: 
1) Identify 5–10 themes that capture the main ideas expressed. 
2) For each theme, provide: 
- ThemeLabel (3–5 neutral words) 
- Definition (short, factual) 
- RepresentativeKeywords (5–10 indicative words/phrases) 
- ParticipantID (row numbers that correspond to the theme)
3) Output ONLY JSON in this format: 
[ 
{{ 
"ThemeLabel": "Theme Name", 
"Definition": "Short definition.", 
"RepresentativeKeywords": ["keyword1", "keyword2"],
"ParticipantID": ["row number1", "row number2"]
 }}
]
```

## CSV Format

Your CSV file should contain open-ended survey responses. The app will analyze all columns and rows in the file.

Example CSV structure:
```csv
ParticipantID,Question1,Question2
1,"I really enjoyed the user interface","The app was easy to use"
2,"The design could be improved","More features would be helpful"
3,"Great overall experience","Would recommend to others"
```

## Output Formats

The application supports two output formats:

### Long Format (themes_by_question_long.csv)
Each row represents one response with its assigned theme:
- **question**: Question identifier (e.g., Q1, Q2)
- **record**: Participant/record ID
- **ThemeLabel**: Theme name
- **Definition**: Theme description
- **Keywords**: Keywords associated with the theme
- **response**: Original response text

### Wide Format (openrouter_codes_by_question.csv)
Each row represents one participant with binary codes for each theme:
- **user_id**: Participant ID
- **[ThemeName]**: Binary columns (0 or 1) for each identified theme

## Technologies Used

- **React 18**: Modern React with hooks
- **Vite**: Fast build tool and development server
- **PapaParse**: CSV parsing and generation
- **Axios**: HTTP client for API calls
- **Lucide React**: Beautiful icons
- **CSS3**: Modern styling with gradients and animations

## Security Notes

- API keys are stored in browser memory only
- No data is sent to any server except OpenAI
- CSV files are processed locally in your browser
- No data is stored on any external servers

## Troubleshooting

### Common Issues

1. **"Failed to connect to OpenAI API"**
   - Check your API key is correct
   - Ensure you have sufficient credits in your OpenAI account
   - Verify your internet connection

2. **"Error parsing CSV file"**
   - Ensure your file is a valid CSV format
   - Check for special characters or encoding issues
   - Try opening the file in a text editor to verify format

3. **"Failed to parse OpenAI response"**
   - This usually means the AI response wasn't in the expected JSON format
   - Try running the analysis again
   - Check the browser console for more details

4. **"Request too large for gpt-5" or token limit errors**
   - The app automatically optimizes data to reduce tokens
   - Try using GPT-3.5 Turbo instead of GPT-4
   - Split your CSV into smaller files (under 100 rows each)
   - Check the data preview to see what's being analyzed

### Performance Tips

- For large CSV files (>100 rows), the app automatically limits analysis to the first 100 rows to avoid token limits
- Choose GPT-3.5 Turbo for large datasets (better token efficiency)
- Choose GPT-4 for smaller datasets (better analysis quality)
- Long text fields are automatically truncated to 200 characters
- You can modify the prompt in the code to suit your specific needs

## Development

To build for production:
```bash
npm run build
```

To preview the production build:
```bash
npm run preview
```

## License

MIT License - feel free to use and modify as needed.

## Support

If you encounter any issues or have questions, please check the troubleshooting section above or create an issue in the repository.
