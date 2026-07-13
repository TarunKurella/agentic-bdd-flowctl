package com.example.application;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public class ApplicationRequest {
    @NotNull
    private ApplicationType applicationType;

    @NotBlank
    private String primaryApplicantId;

    private String jointApplicantId;

    @NotBlank
    @Size(min = 3, max = 12)
    private String productCode;
}
